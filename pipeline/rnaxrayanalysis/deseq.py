"""DESeq2 two-condition Wald test, ported to numpy for the desktop runtime.

``bin/DESeq_run.R`` runs ``DESeq()`` with the defaults and then
``results(dds, contrast=c("conditions","condition_one","condition_two"),
alpha=0.01)`` after dropping rows with ``rowSums(counts) <= min``.  This
module repeats those steps for a design with one two-level factor, following
DESeq2 1.46 (R/core.R and src/DESeq2.cpp):

- median-of-ratios size factors;
- gene-wise dispersion with the Cox-Reid adjusted likelihood, maximized by
  the same Armijo line search (grid search when it does not converge);
- parametric trend ``asymptDisp + extraPois / mean`` (Gamma-identity GLM);
- prior variance of the log dispersions (for 1-3 residual degrees of freedom
  DESeq2 matches a simulated distribution; R's random numbers are reproduced
  exactly, so the result is the same);
- MAP dispersion with outliers kept at the gene-wise value;
- IRLS for the coefficients with the ridge 1e-6 and ``minmu`` 0.5, Wald test;
- Cook's distance filtering for cells with three or more replicates;
- independent filtering on the mean of normalized counts (``lowess`` port)
  and Benjamini-Hochberg.

The heavy per-row loops use numba when it is installed and plain Python
otherwise (same code, much slower, fine for small tables).
"""
from __future__ import annotations

import math
from typing import Dict, Sequence, Tuple

import numpy as np

try:  # pragma: no cover - exercised implicitly
    from numba import njit, prange
except ImportError:  # pragma: no cover
    prange = range

    def njit(*args, **kwargs):
        if args and callable(args[0]):
            return args[0]
        return lambda fn: fn

MIN_DISP = 1e-8
MIN_MU = 0.5
KAPPA_0 = 1.0
DISP_TOL = 1e-6
MAXIT = 100
BETA_TOL = 1e-8
LAMBDA = 1e-6
LARGE = 30.0
EPSILON = 1e-4


# --- special functions --------------------------------------------------------

@njit(cache=False)
def _digamma(x):
    result = 0.0
    while x < 6.0:
        result -= 1.0 / x
        x += 1.0
    f = 1.0 / (x * x)
    return result + math.log(x) - 0.5 / x - f * (1.0 / 12 - f * (1.0 / 120 - f * (1.0 / 252 - f * (
        1.0 / 240 - f * (1.0 / 132 - f * (691.0 / 32760 - f / 12.0))))))


def trigamma(x: float) -> float:
    result = 0.0
    while x < 6.0:
        result += 1.0 / (x * x)
        x += 1.0
    f = 1.0 / (x * x)
    return result + 1.0 / x + f / 2 + f / x * (1.0 / 6 - f * (1.0 / 30 - f * (1.0 / 42 - f * (1.0 / 30 - f * 5.0 / 66))))


def _norm_sf(z: np.ndarray) -> np.ndarray:
    """Upper tail of the standard normal, accurate far into the tail."""
    erfc = np.frompyfunc(math.erfc, 1, 1)
    return erfc(np.asarray(z, dtype=float) / math.sqrt(2.0)).astype(float) * 0.5


# --- R's lgammafn (nmath/lgamma.c, gamma.c, lgammacor.c, chebyshev.c) ---------
# The dispersion likelihood is a sum of lgamma(y + 1/alpha) - lgamma(1/alpha)
# terms; for small alpha each is the difference of two large numbers, so the
# last bits of lgamma decide the line search's accept / stop tests.  DESeq2
# calls R's lgammafn, which differs from the C library's by an ulp or more in
# about half of the arguments; this is R's algorithm with the fused
# multiply-adds that R's arm64 build (clang, -ffp-contract=on) uses.

_GAMCS = np.array([
    +.8571195590989331421920062399942e-2, +.4415381324841006757191315771652e-2,
    +.5685043681599363378632664588789e-1, -.4219835396418560501012500186624e-2,
    +.1326808181212460220584006796352e-2, -.1893024529798880432523947023886e-3,
    +.3606925327441245256578082217225e-4, -.6056761904460864218485548290365e-5,
    +.1055829546302283344731823509093e-5, -.1811967365542384048291855891166e-6,
    +.3117724964715322277790254593169e-7, -.5354219639019687140874081024347e-8,
    +.9193275519859588946887786825940e-9, -.1577941280288339761767423273953e-9,
    +.2707980622934954543266540433089e-10, -.4646818653825730144081661058933e-11,
    +.7973350192007419656460767175359e-12, -.1368078209830916025799499172309e-12,
    +.2347319486563800657233471771688e-13, -.4027432614949066932766570534699e-14,
    +.6910051747372100912138336975257e-15, -.1185584500221992907052387126192e-15])
_ALGMCS = np.array([
    +.1666389480451863247205729650822e+0, -.1384948176067563840732986059135e-4,
    +.9810825646924729426157171547487e-8, -.1809129475572494194263306266719e-10,
    +.6221098041892605227126015543416e-13])
_LN_SQRT_2PI = 0.918938533204672741780329736406


@njit(cache=False)
def _fma(a, b, c):
    """a * b + c with one rounding (Dekker product + error-free sums; exact
    except, rarely, an ulp off at a rounding tie)."""
    p = a * b
    t = 134217729.0 * a
    ah = t - (t - a)
    al = a - ah
    t = 134217729.0 * b
    bh = t - (t - b)
    bl = b - bh
    e = ((ah * bh - p) + ah * bl + al * bh) + al * bl
    s = p + c
    bb = s - p
    err = (p - (s - bb)) + (c - bb)
    return s + (err + e)


@njit(cache=False)
def _chebyshev_r(x, a, n):
    twox = x * 2.0
    b0 = 0.0
    b1 = 0.0
    b2 = 0.0
    for i in range(1, n + 1):
        b2 = b1
        b1 = b0
        b0 = _fma(twox, b1, -b2) + a[n - i]
    return (b0 - b2) * 0.5


@njit(cache=False)
def _lgamma_r(x):
    """R's lgammafn(x) for x > 0."""
    if x < 1e-306:
        return -math.log(x)
    if x <= 10.0:
        n = int(x)
        y = x - n
        n -= 1
        value = _chebyshev_r(y * 2.0 - 1.0, _GAMCS, 22) + .9375
        if n < 0:
            value /= x
        else:
            for i in range(1, n + 1):
                value *= (y + i)
        return math.log(abs(value))
    if x > 1e17:
        return x * (math.log(x) - 1.0)
    base = _fma(x - 0.5, math.log(x), _LN_SQRT_2PI) - x
    if x > 4934720.0:
        return base
    if x < 94906265.62425156:
        tmp = 10.0 / x
        cor = _chebyshev_r(tmp * tmp * 2.0 - 1.0, _ALGMCS, 5) / x
    else:
        cor = 1.0 / (x * 12.0)
    return base + cor


# --- dispersion likelihood (src/DESeq2.cpp) -----------------------------------
# x is the 0/1 group membership of each sample (group 1 is the coefficient
# column of R's model matrix ~conditions); for this design X'WX is
# [[sum(W), sum1(W)], [sum1(W), sum1(W)]] with sum1 over group 1, and
# trace((X'WX)^-1 d(X'WX)) is the sum over groups of sum(dW) / sum(W).
# log_posterior is evaluated in DESeq2's order, which matters for small alpha
# (each term lgamma(y + 1/alpha) - lgamma(1/alpha) is a difference of two
# large numbers; summing the lgamma(y + 1/alpha) first and subtracting
# n * lgamma(1/alpha) at the end loses up to 8 digits): sum over samples of
# lgamma(y + 1/a) - lgamma(1/a) - y log(mu + 1/a) - 1/a log(1 + mu a), plus
# the prior, minus log(det(X'WX)) / 2 with Armadillo's 2 x 2 determinant
# b00 * b11 - b01 * b10 (one fused multiply-add in R's arm64 build).  With R's
# lgammafn this gives R's log posterior to the last bit.

@njit(cache=False)
def _log_post(log_alpha, y, mu, group, ngroups, prior_mean, prior_var, use_prior):
    alpha = math.exp(log_alpha)
    r = 1.0 / alpha
    n = y.shape[0]
    lgr = _lgamma_r(r)
    ll = 0.0
    for j in range(n):
        ll += _lgamma_r(y[j] + r) - lgr - y[j] * math.log(mu[j] + r) - r * math.log(1.0 + mu[j] * alpha)
    s = 0.0
    s1 = 0.0
    for j in range(n):
        w = 1.0 / (1.0 / mu[j] + alpha)
        s += w
        if group[j] == 1:
            s1 += w
    cr = -0.5 * math.log(_fma(s, s1, -(s1 * s1)))
    prior = 0.0
    if use_prior:
        d = log_alpha - prior_mean
        prior = -0.5 * (d * d) / prior_var
    return ll + prior + cr


@njit(cache=False)
def _dlog_post(log_alpha, y, mu, group, ngroups, prior_mean, prior_var, use_prior):
    alpha = math.exp(log_alpha)
    r = 1.0 / alpha
    n = y.shape[0]
    s = 0.0
    dg = _digamma(r)
    for j in range(n):
        s += dg + math.log(1.0 + mu[j] * alpha) - mu[j] * alpha / (1.0 + mu[j] * alpha) \
            - _digamma(y[j] + r) + y[j] / (mu[j] + r)
    ll = r * r * s
    cr = 0.0
    for g in range(ngroups):
        sw = 0.0
        sdw = 0.0
        for j in range(n):
            if group[j] == g:
                t = 1.0 / mu[j] + alpha
                sw += 1.0 / t
                sdw -= 1.0 / (t * t)
        cr += sdw / sw
    prior = 0.0
    if use_prior:
        prior = -(log_alpha - prior_mean) / prior_var
    return (ll - 0.5 * cr) * alpha + prior


@njit(cache=False, parallel=True)
def _fit_disp(y, mu, group, ngroups, log_alpha0, prior_mean, prior_var, use_prior, min_log_alpha):
    nrow = y.shape[0]
    log_alpha = np.empty(nrow)
    iters = np.zeros(nrow, dtype=np.int64)
    initial_lp = np.empty(nrow)
    last_lp = np.empty(nrow)
    for i in prange(nrow):
        a = log_alpha0[i]
        yi = y[i]
        mi = mu[i]
        pm = prior_mean[i]
        lp = _log_post(a, yi, mi, group, ngroups, pm, prior_var, use_prior)
        dlp = _dlog_post(a, yi, mi, group, ngroups, pm, prior_var, use_prior)
        kappa = KAPPA_0
        initial_lp[i] = lp
        accepts = 0
        it = 0
        for t in range(MAXIT):
            it += 1
            a_propose = a + kappa * dlp
            if a_propose < -30.0:
                kappa = (-30.0 - a) / dlp
            if a_propose > 10.0:
                kappa = (10.0 - a) / dlp
            theta_kappa = -_log_post(a + kappa * dlp, yi, mi, group, ngroups, pm, prior_var, use_prior)
            theta_hat_kappa = -lp - kappa * EPSILON * dlp * dlp
            if theta_kappa <= theta_hat_kappa:
                accepts += 1
                a = a + kappa * dlp
                lpnew = _log_post(a, yi, mi, group, ngroups, pm, prior_var, use_prior)
                change = lpnew - lp
                if change < DISP_TOL:
                    lp = lpnew
                    break
                if a < min_log_alpha:
                    break
                lp = lpnew
                dlp = _dlog_post(a, yi, mi, group, ngroups, pm, prior_var, use_prior)
                kappa = min(kappa * 1.1, KAPPA_0)
                if accepts % 5 == 0:
                    kappa = kappa / 2.0
            else:
                kappa = kappa / 2.0
        iters[i] = it
        last_lp[i] = lp
        log_alpha[i] = a
    return log_alpha, iters, initial_lp, last_lp


@njit(cache=False, parallel=True)
def _fit_disp_grid(y, mu, group, ngroups, grid, prior_mean, prior_var, use_prior):
    nrow = y.shape[0]
    n = grid.shape[0]
    delta = grid[1] - grid[0]
    out = np.empty(nrow)
    for i in prange(nrow):
        best = -np.inf
        a_hat = grid[0]
        for t in range(n):
            lp = _log_post(grid[t], y[i], mu[i], group, ngroups, prior_mean[i], prior_var, use_prior)
            if lp > best:
                best = lp
                a_hat = grid[t]
        best = -np.inf
        lo = a_hat - delta
        step = 2.0 * delta / (n - 1)
        res = lo
        for t in range(n):
            a = lo + step * t
            lp = _log_post(a, y[i], mu[i], group, ngroups, prior_mean[i], prior_var, use_prior)
            if lp > best:
                best = lp
                res = a
        out[i] = res
    return out


def _grid_refit(y, mu, group, ngroups, prior_mean, prior_var, use_prior, ncol):
    grid = np.linspace(math.log(1e-8), math.log(max(10.0, ncol)), 20)
    return np.exp(_fit_disp_grid(y, mu, group, ngroups, grid, prior_mean, prior_var, use_prior))


# --- IRLS for the GLM coefficients (fitBeta) ----------------------------------

@njit(cache=False)
def _dnbinom_log(y, size, mu):
    # R's dnbinom_mu(log=TRUE) for the deviance convergence test.
    if y == 0:
        return size * (math.log(size / (size + mu)) if size < mu else math.log1p(-mu / (size + mu)))
    return (math.lgamma(y + size) - math.lgamma(size) - math.lgamma(y + 1.0)
            + size * math.log(size / (size + mu)) + y * math.log(mu / (size + mu)))


@njit(cache=False)
def _inv2(a):
    # numba's np.linalg needs scipy, which the runtime does not ship
    det = a[0, 0] * a[1, 1] - a[0, 1] * a[1, 0]
    inv = np.empty((2, 2))
    inv[0, 0] = a[1, 1] / det
    inv[0, 1] = -a[0, 1] / det
    inv[1, 0] = -a[1, 0] / det
    inv[1, 1] = a[0, 0] / det
    return inv


@njit(cache=False, parallel=True)
def _fit_beta(y, nf, x, alpha, beta0, lam):
    nrow, m = y.shape
    p = x.shape[1]
    beta_out = np.empty((nrow, p))
    var_out = np.empty((nrow, p))
    hat_out = np.empty((nrow, m))
    iters = np.zeros(nrow, dtype=np.int64)
    for i in prange(nrow):
        beta = beta0[i].copy()
        mu = np.empty(m)
        for j in range(m):
            eta = 0.0
            for k in range(p):
                eta += x[j, k] * beta[k]
            mu[j] = max(nf[i, j] * math.exp(eta), MIN_MU)
        dev_old = 0.0
        it = 0
        for t in range(MAXIT):
            it += 1
            a = np.zeros((p, p))
            b = np.zeros(p)
            for j in range(m):
                w = mu[j] / (1.0 + alpha[i] * mu[j])
                z = math.log(mu[j] / nf[i, j]) + (y[i, j] - mu[j]) / mu[j]
                for k in range(p):
                    b[k] += x[j, k] * w * z
                    for l in range(p):
                        a[k, l] += x[j, k] * w * x[j, l]
            for k in range(p):
                a[k, k] += lam[k]
            ia = _inv2(a)
            beta = np.empty(p)
            for k in range(p):
                beta[k] = ia[k, 0] * b[0] + ia[k, 1] * b[1]
            big = False
            for k in range(p):
                if abs(beta[k]) > LARGE:
                    big = True
            if big:
                it = MAXIT
                break
            for j in range(m):
                eta = 0.0
                for k in range(p):
                    eta += x[j, k] * beta[k]
                mu[j] = max(nf[i, j] * math.exp(eta), MIN_MU)
            dev = 0.0
            for j in range(m):
                dev += -2.0 * _dnbinom_log(y[i, j], 1.0 / alpha[i], mu[j])
            conv = abs(dev - dev_old) / (abs(dev) + 0.1)
            if math.isnan(conv):
                it = MAXIT
                break
            if t > 0 and conv < BETA_TOL:
                break
            dev_old = dev
        iters[i] = it
        beta_out[i] = beta
        xtwx = np.zeros((p, p))
        wv = np.empty(m)
        for j in range(m):
            wv[j] = mu[j] / (1.0 + alpha[i] * mu[j])
            for k in range(p):
                for l in range(p):
                    xtwx[k, l] += x[j, k] * wv[j] * x[j, l]
        ridge = xtwx.copy()
        for k in range(p):
            ridge[k, k] += lam[k]
        inv = _inv2(ridge)
        for k in range(p):  # diag(inv @ xtwx @ inv)
            v = 0.0
            for l in range(p):
                for q in range(p):
                    v += inv[k, l] * xtwx[l, q] * inv[q, k]
            var_out[i, k] = v
        for j in range(m):
            h = 0.0
            for k in range(p):
                for l in range(p):
                    h += x[j, k] * inv[k, l] * x[j, l]
            hat_out[i, j] = wv[j] * h
    return beta_out, var_out, hat_out, iters


# --- R helpers -----------------------------------------------------------------

def _mad(x: np.ndarray) -> float:
    med = np.median(x)
    return 1.4826 * float(np.median(np.abs(x - med)))


def p_adjust_bh(p: np.ndarray) -> np.ndarray:
    """R ``p.adjust(p, "BH")``; NaN entries stay NaN and are not counted."""
    p = np.asarray(p, dtype=float)
    out = np.full(p.shape, np.nan)
    ok = ~np.isnan(p)
    q = p[ok]
    n = len(q)
    if n == 0:
        return out
    order = np.argsort(-q, kind="stable")
    i = np.arange(n, 0, -1, dtype=float)
    adj = np.minimum(1.0, np.minimum.accumulate(n / i * q[order]))
    res = np.empty(n)
    res[order] = adj
    out[ok] = res
    return out


def _quantile7(x: np.ndarray, probs: np.ndarray) -> np.ndarray:
    xs = np.sort(x)
    n = len(xs)
    h = (n - 1) * probs
    lo = np.floor(h + 4 * np.finfo(float).eps).astype(int)  # R uses fuzz 4*eps
    lo = np.clip(lo, 0, n - 1)
    hi = np.clip(lo + 1, 0, n - 1)
    frac = h - lo
    frac[np.abs(frac) < 4 * np.finfo(float).eps] = 0.0
    return xs[lo] + frac * (xs[hi] - xs[lo])


def lowess(x: Sequence[float], y: Sequence[float], f: float = 2 / 3, nsteps: int = 3,
           delta: float = None) -> np.ndarray:
    """R ``lowess`` (clowess in src/library/stats/src/lowess.c); x sorted."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    if delta is None:
        delta = 0.01 * (x[-1] - x[0])
    ys = np.zeros(n)
    if n < 2:
        ys[:] = y
        return ys
    rw = np.zeros(n)
    res = np.zeros(n)
    ns = max(2, min(n, int(f * n + 1e-7)))

    def lowest(xs, nleft, nright, userw):
        # 0-based nleft/nright, inclusive
        rng = x[n - 1] - x[0]
        h = max(xs - x[nleft], x[nright] - xs)
        h9, h1 = 0.999 * h, 0.001 * h
        w = res  # R passes the residual buffer as scratch weights
        a = 0.0
        j = nleft
        while j < n:
            w[j] = 0.0
            r = abs(x[j] - xs)
            if r <= h9:
                w[j] = 1.0 if r <= h1 else (1.0 - (r / h) ** 3) ** 3
                if userw:
                    w[j] *= rw[j]
                a += w[j]
            elif x[j] > xs:
                break
            j += 1
        nrt = j - 1
        if a <= 0.0:
            return None
        for k in range(nleft, nrt + 1):
            w[k] /= a
        if h > 0.0:
            a = sum(w[k] * x[k] for k in range(nleft, nrt + 1))
            b = xs - a
            c = sum(w[k] * (x[k] - a) ** 2 for k in range(nleft, nrt + 1))
            if math.sqrt(c) > 0.001 * rng:
                b /= c
                for k in range(nleft, nrt + 1):
                    w[k] *= b * (x[k] - a) + 1.0
        return sum(w[k] * y[k] for k in range(nleft, nrt + 1))

    it = 1
    while it <= nsteps + 1:
        nleft, nright, last, i = 0, ns - 1, -1, 0
        while True:
            if nright < n - 1:
                d1 = x[i] - x[nleft]
                d2 = x[nright + 1] - x[i]
                if d1 > d2:
                    nleft += 1
                    nright += 1
                    continue
            val = lowest(x[i], nleft, nright, it > 1)
            ys[i] = y[i] if val is None else val
            if last < i - 1:
                denom = x[i] - x[last]
                for j in range(last + 1, i):
                    alpha = (x[j] - x[last]) / denom
                    ys[j] = alpha * ys[i] + (1.0 - alpha) * ys[last]
            last = i
            cut = x[last] + delta
            i = last + 1
            while i < n:
                if x[i] > cut:
                    break
                if x[i] == x[last]:
                    ys[i] = ys[last]
                    last = i
                i += 1
            i = max(last + 1, i - 1)
            if last >= n - 1:
                break
        res[:] = y - ys
        sc = float(np.sum(np.abs(res))) / n
        if it > nsteps:
            break
        ar = np.sort(np.abs(res))
        m1 = n // 2
        cmad = 3.0 * (ar[m1] + ar[n - m1 - 1]) if n % 2 == 0 else 6.0 * ar[m1]
        if cmad < 1e-7 * sc:
            break
        c9, c1 = 0.999 * cmad, 0.001 * cmad
        r = np.abs(res)
        rw[:] = np.where(r <= c1, 1.0, np.where(r <= c9, (1.0 - (r / cmad) ** 2) ** 2, 0.0))
        it += 1
    return ys


# --- prior variance for few residual degrees of freedom ----------------------
#
# For 1 <= m - p <= 3 DESeq2 (estimateDispersionsPriorVar) picks the variance v
# in seq(0, 8, length = 200) whose simulated distribution
#   log(rchisq(1e4, df)) + rnorm(1e4, 0, sqrt(v)) - log(df)
# drawn after set.seed(2) is closest (KL divergence of the histograms with
# breaks -20:20/2) to the observed log-dispersion residuals, smooths the 200
# divergences with loess(span = .2) and takes the minimum on a 1000-point grid.
# The draws are part of the result, so they are reproduced exactly: R's default
# generator (Mersenne-Twister seeded as set.seed does; numpy's MT19937 produces
# the same 32-bit stream from that state), normals by inversion, nmath rgamma
# (Ahrens-Dieter GD for a >= 1, GS for a < 1) and exp_rand.  The simulated
# histograms do not depend on the data and are computed once per df.  (The exact
# density, which earlier versions used, gives a different minimum: 1e4 draws
# leave enough noise to move dispPriorVar by 10% or more.)

_I2_32M1 = 2.328306437080797e-10
_EXP_RAND_Q = np.array([0.6931471805599453, 0.9333736875190459, 0.9888777961838675, 0.9984959252914960040,
                        0.9998292811061389, 0.9999833164100727, 0.9999985508193277, 0.9999998906925558,
                        0.9999999924734159, 0.9999999995283275, 0.9999999999728814, 0.9999999999985598,
                        0.9999999999999289, 0.9999999999999968, 0.9999999999999999, 1.0])
_PRIOR_VAR_FUZZY = np.arange(-20, 21) / 2.0 + np.where(np.arange(41) == 0, -5e-8, 5e-8)


def _r_seed_state(seed: int) -> dict:
    """numpy MT19937 state equal to R's after ``set.seed(seed)``."""
    s = seed & 0xFFFFFFFF
    for _ in range(50):
        s = (69069 * s + 1) & 0xFFFFFFFF
    s = (69069 * s + 1) & 0xFFFFFFFF  # dummy[0], replaced by mti = N
    key = np.empty(624, dtype=np.uint32)
    for j in range(624):
        s = (69069 * s + 1) & 0xFFFFFFFF
        key[j] = s
    return {"bit_generator": "MT19937", "state": {"key": key, "pos": 624}}


@njit(cache=False)
def _unif_r(raw, pos):
    x = float(raw[pos]) * 2.3283064365386963e-10
    if x <= 0.0:
        x = 0.5 * _I2_32M1
    elif 1.0 - x <= 0.0:
        x = 1.0 - 0.5 * _I2_32M1
    return x


@njit(cache=False)
def _qnorm_r(p):
    """qnorm(p) (Wichura AS241, R's nmath/qnorm.c) for 0 < p < 1."""
    q = p - 0.5
    if abs(q) <= 0.425:
        r = 0.180625 - q * q
        return q * (((((((r * 2509.0809287301226727 + 33430.575583588128105) * r + 67265.770927008700853) * r
                         + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r
                      + 133.14166789178437745) * r + 3.387132872796366608) \
            / (((((((r * 5226.495278852545925 + 28729.085735721942674) * r + 39307.89580009271061) * r
                   + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r
                + 42.313330701600911252) * r + 1.0)
    r = math.sqrt(-math.log(p if q < 0 else 1.0 - p))
    if r <= 5.0:
        r -= 1.6
        val = (((((((r * 7.7454501427834140764e-4 + 0.0227238449892691845833) * r + 0.24178072517745061177) * r
                   + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r
                + 4.6303378461565452959) * r + 1.42343711074968357734) \
            / (((((((r * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r
                   + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r
                + 2.05319162663775882187) * r + 1.0)
    else:
        r -= 5.0
        val = (((((((r * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r
                   + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r
                + 5.4637849111641143699) * r + 6.6579046435011037772) \
            / (((((((r * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r
                   + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r
                + 0.59983220655588793769) * r + 1.0)
    return -val if q < 0 else val


@njit(cache=False)
def _exp_rand_r(raw, pos, qexp):
    a = 0.0
    u = _unif_r(raw, pos)
    pos += 1
    while u <= 0.0 or u >= 1.0:
        u = _unif_r(raw, pos)
        pos += 1
    while True:
        u += u
        if u > 1.0:
            break
        a += qexp[0]
    u -= 1.0
    if u <= qexp[0]:
        return a + u, pos
    i = 0
    umin = _unif_r(raw, pos)
    pos += 1
    while True:
        ustar = _unif_r(raw, pos)
        pos += 1
        if umin > ustar:
            umin = ustar
        i += 1
        if not u > qexp[i]:
            break
    return a + umin * qexp[0], pos


@njit(cache=False)
def _gd_quotient(t, s, s2, q0):
    v = t / (s + s)
    if abs(v) <= 0.25:
        return q0 + 0.5 * t * t * ((((((0.1233795 * v - 0.1367177) * v + 0.1423657) * v - 0.1662921) * v
                                      + 0.2000062) * v - 0.250003) * v + 0.3333333) * v
    return q0 - s * t + 0.25 * t * t + (s2 + s2) * math.log(1.0 + v)


@njit(cache=False)
def _rgamma_draws(raw, a, scale, out, qexp):
    """``out[:] = rgamma(len(out), a, scale)`` from the raw MT stream (R's nmath
    rgamma.c); returns the number of raw values used, or -1 if ``raw`` is too
    short (the caller retries with more)."""
    pos = 0
    limit = raw.shape[0] - 64
    for k in range(out.shape[0]):
        if pos > limit:
            return -1
        if a < 1.0:
            e0 = 1.0 + 0.36787944117144233 * a
            while True:
                if pos > limit:
                    return -1
                pp = e0 * _unif_r(raw, pos)
                pos += 1
                if pp >= 1.0:
                    x = -math.log((e0 - pp) / a)
                    e, pos = _exp_rand_r(raw, pos, qexp)
                    if e >= (1.0 - a) * math.log(x):
                        break
                else:
                    x = math.exp(math.log(pp) / a)
                    e, pos = _exp_rand_r(raw, pos, qexp)
                    if e >= x:
                        break
            out[k] = scale * x
            continue
        s2 = a - 0.5
        s = math.sqrt(s2)
        d = 5.656854 - s * 12.0
        u = _unif_r(raw, pos)
        u = math.trunc(134217728.0 * u) + _unif_r(raw, pos + 1)
        pos += 2
        t = _qnorm_r(u / 134217728.0)
        x = s + 0.5 * t
        ret = x * x
        if t >= 0.0:
            out[k] = scale * ret
            continue
        u = _unif_r(raw, pos)
        pos += 1
        if d * u <= t * t * t:
            out[k] = scale * ret
            continue
        r = 1.0 / a
        q0 = ((((((2.424e-4 * r + 2.4511e-4) * r - 7.388e-5) * r + 0.00144121) * r + 0.00801191) * r
               + 0.02083148) * r + 0.04166669) * r
        if a <= 3.686:
            b = 0.463 + s + 0.178 * s2
            si = 1.235
            c = 0.195 / s - 0.079 + 0.16 * s
        elif a <= 13.022:
            b = 1.654 + 0.0076 * s2
            si = 1.68 / s + 0.275
            c = 0.062 / s + 0.024
        else:
            b = 1.77
            si = 0.75
            c = 0.1515 / s
        if x > 0.0 and math.log(1.0 - u) <= _gd_quotient(t, s, s2, q0):
            out[k] = scale * ret
            continue
        while True:
            if pos > limit:
                return -1
            e, pos = _exp_rand_r(raw, pos, qexp)
            u = _unif_r(raw, pos)
            pos += 1
            u = u + u - 1.0
            t = b - si * e if u < 0.0 else b + si * e
            if t >= -0.71874483771719:
                q = _gd_quotient(t, s, s2, q0)
                if q > 0.0 and c * abs(u) <= math.expm1(q) * math.exp(e - 0.5 * t * t):
                    break
        x = s + 0.5 * t
        out[k] = scale * x * x
    return pos


def _norm_draws(raw: np.ndarray, n: int) -> np.ndarray:
    """``rnorm(n)`` (inversion: two uniforms per value) from the raw stream."""
    u = raw[:2 * n].astype(np.float64) * 2.3283064365386963e-10
    u = np.where(u <= 0.0, 0.5 * _I2_32M1, np.where(1.0 - u <= 0.0, 1.0 - 0.5 * _I2_32M1, u))
    p = (np.trunc(134217728.0 * u[0::2]) + u[1::2]) / 134217728.0
    return _qnorm_many(p)


@njit(cache=False)
def _qnorm_many(p):
    out = np.empty(p.shape[0])
    for i in range(p.shape[0]):
        out[i] = _qnorm_r(p[i])
    return out


def _hist_counts_r(values: np.ndarray) -> np.ndarray:
    """hist(values, breaks = -20:20/2)$counts after keeping -10 < values < 10
    (right-closed bins, edges moved by hist's fuzz)."""
    v = values[(values > -10.0) & (values < 10.0)]
    return np.bincount(np.searchsorted(_PRIOR_VAR_FUZZY, v, side="left") - 1, minlength=40)[:40].astype(float)


_SIMULATED_LOG_DISP: Dict[int, np.ndarray] = {}


def _simulated_log_disp(df: int) -> np.ndarray:
    """Densities (200 x 40) of DESeq2's simulated histograms for ``df``."""
    if df in _SIMULATED_LOG_DISP:
        return _SIMULATED_LOG_DISP[df]
    bg = np.random.MT19937()
    bg.state = _r_seed_state(2)
    n_draw = 10000
    chi = np.empty(n_draw)
    dens = np.empty((200, 40))
    log_df = math.log(df)
    for gi, v in enumerate(np.linspace(0.0, 8.0, 200)):
        state = bg.state
        size = 8 * n_draw
        while True:
            used = _rgamma_draws(bg.random_raw(size), df / 2.0, 2.0, chi, _EXP_RAND_Q)  # rchisq(1e4, df)
            if used >= 0:
                break
            bg.state = state
            size *= 2
        bg.state = state
        bg.random_raw(used)
        if v == 0:
            z = 0.0  # rnorm(.., 0, 0) returns 0 without drawing
        else:
            z = 0.0 + math.sqrt(v) * _norm_draws(bg.random_raw(2 * n_draw), n_draw)
        counts = _hist_counts_r(np.log(chi) + z - log_df)
        dens[gi] = counts / (counts.sum() * 0.5)
    _SIMULATED_LOG_DISP[df] = dens
    return dens


def _prior_var_few_df(residuals: np.ndarray, df: int) -> float:
    """estimateDispersionsPriorVar for 1 <= m - p <= 3 (see above)."""
    obs_counts = _hist_counts_r(residuals)
    obs_dens = obs_counts / (obs_counts.sum() * 0.5)
    obs_small = obs_dens[obs_dens > 0].min()
    dens = _simulated_log_disp(df)
    kls = np.empty(200)
    for gi in range(200):
        rand_dens = dens[gi]
        pos = rand_dens[rand_dens > 0]
        small = min(obs_small, pos.min()) if pos.size else obs_small
        terms = obs_dens * (np.log(obs_dens + small) - np.log(rand_dens + small))
        kl = 0.0
        for t in terms:  # sum() in order (R's long double is a double on arm64)
            kl += float(t)
        kls[gi] = kl
    grid = np.linspace(0.0, 8.0, 200)
    fine = np.linspace(0.0, 8.0, 1000)
    arg = fine[int(np.argmin(_loess(grid, kls, fine, span=0.2)))]
    return max(arg, 0.25)


def _loess(x: np.ndarray, y: np.ndarray, at: np.ndarray, *, span: float, cell: float = 0.2) -> np.ndarray:
    """``predict(loess(y ~ x, span = span), at)`` for one predictor.

    R's default ``surface = "interpolate"``: local quadratic fits with tricube
    weights over the ``floor(n * span)`` nearest points are computed only at
    the vertices of a kd tree (cells are split at the median point while they
    hold more than ``floor(n * span * cell)`` points; the box is the data range
    widened by 0.5% on each side) and blended with cubic Hermite polynomials
    from the vertex values and slopes (netlib dloess ehg124/ehg126/ehg128).
    """
    order = np.argsort(x, kind="stable")
    xs = np.asarray(x, dtype=float)[order]
    ys = np.asarray(y, dtype=float)[order]
    n = len(xs)
    q = int(math.floor(n * span))
    fc = int(math.floor(n * span * cell))
    margin = 0.005 * max(xs[-1] - xs[0], 1e-10 * max(abs(xs[0]), abs(xs[-1])) + 1e-30)
    vertices = {xs[0] - margin, xs[-1] + margin}
    stack = [(0, n - 1, xs[0] - margin, xs[-1] + margin)]
    while stack:
        lo, hi, left, right = stack.pop()
        if hi - lo + 1 <= fc:
            continue
        m = (lo + hi + 2) // 2 - 1  # Fortran m = (l + u) / 2 on 1-based indices
        split = xs[m]
        if split == left or split == right:
            continue
        vertices.add(split)
        stack.append((lo, m, left, split))
        stack.append((m + 1, hi, split, right))
    vx = np.array(sorted(vertices))

    def local(x0: float) -> Tuple[float, float]:
        d = np.abs(xs - x0)
        h = max(float(np.partition(d, q - 1)[q - 1]), 1e-12)
        w = np.where(d < h, (1 - (d / h) ** 3) ** 3, 0.0)
        t = xs - x0
        a = np.array([[np.sum(w * t ** (r + c)) for c in range(3)] for r in range(3)])
        b = np.array([np.sum(w * ys * t ** r) for r in range(3)])
        coef = np.linalg.solve(a, b)
        return float(coef[0]), float(coef[1])

    fits = [local(v) for v in vx]
    f = np.array([value for value, _ in fits])
    slope = np.array([value for _, value in fits])
    at = np.asarray(at, dtype=float)
    i = np.clip(np.searchsorted(vx, at, side="right") - 1, 0, len(vx) - 2)
    width = vx[i + 1] - vx[i]
    t = (at - vx[i]) / width
    return ((1 - t) ** 2 * (1 + 2 * t) * f[i] + t ** 2 * (3 - 2 * t) * f[i + 1]
            + (t * (1 - t) ** 2 * slope[i] - t ** 2 * (1 - t) * slope[i + 1]) * width)


# --- parametric trend ----------------------------------------------------------

def _parametric_fit(means: np.ndarray, disps: np.ndarray):
    coefs = np.array([0.1, 1.0])
    for _ in range(11):
        resid = disps / (coefs[0] + coefs[1] / means)
        good = (resid > 1e-4) & (resid < 15)
        yv = disps[good]
        xv = 1.0 / means[good]
        c = coefs.copy()
        converged = False

        def deviance(cc):
            mu = cc[0] + cc[1] * xv
            if not np.all(np.isfinite(mu)) or not np.all(mu > 0):
                return None
            return float(-2.0 * np.sum(np.log(yv / mu) - (yv - mu) / mu))

        dev_old = deviance(c)
        if dev_old is None:
            raise ValueError("parametric dispersion fit failed")
        for _glm in range(25):  # glm.fit, Gamma(link="identity"), start = coefs
            mu = c[0] + c[1] * xv
            w = 1.0 / mu ** 2
            sw = w.sum(); swx = (w * xv).sum(); swxx = (w * xv * xv).sum()
            swy = (w * yv).sum(); swxy = (w * xv * yv).sum()
            det = sw * swxx - swx * swx
            new = np.array([(swxx * swy - swx * swxy) / det, (sw * swxy - swx * swy) / det])
            dev = deviance(new)
            halvings = 0
            while dev is None:  # glm.fit halves the step until mu is valid again
                halvings += 1
                if halvings > 25:
                    raise ValueError("parametric dispersion fit failed")
                new = (new + c) / 2
                dev = deviance(new)
            c = new
            if abs(dev - dev_old) / (abs(dev) + 0.1) < 1e-8:
                converged = True
                break
            dev_old = dev
        old = coefs
        coefs = c
        if not np.all(coefs > 0):
            raise ValueError("parametric dispersion fit failed")
        if np.sum(np.log(coefs / old) ** 2) < 1e-6 and converged:
            return coefs
    raise ValueError("parametric dispersion fit did not converge")


def _locfit_eig_dec(z: list) -> list:
    """locfit's ``eig_dec`` (m_eigen.c): cyclic Jacobi on a 3 x 3 matrix in place; returns
    the eigenvectors (columns)."""
    q = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    for _ in range(20):
        moved = False
        for i in range(3):
            for j in range(i + 1, 3):
                if z[i * 3 + j] * z[i * 3 + j] > 1.0e-15 * abs(z[i * 3 + i] * z[j * 3 + j]):
                    c = (z[j * 3 + j] - z[i * 3 + i]) / 2
                    s = -z[i * 3 + j]
                    r = math.sqrt(c * c + s * s)
                    c /= r
                    s = math.sqrt((1 - c) / 2) * (1 if s > 0 else -1)
                    c = math.sqrt((1 + c) / 2)
                    for k in range(3):
                        u, v = z[i * 3 + k], z[j * 3 + k]
                        z[i * 3 + k] = u * c + v * s
                        z[j * 3 + k] = v * c - u * s
                    for k in range(3):
                        u, v = z[k * 3 + i], z[k * 3 + j]
                        z[k * 3 + i] = u * c + v * s
                        z[k * 3 + j] = v * c - u * s
                    z[i * 3 + j] = z[j * 3 + i] = 0.0
                    for k in range(3):
                        u, v = q[k * 3 + i], q[k * 3 + j]
                        q[k * 3 + i] = u * c + v * s
                        q[k * 3 + j] = v * c - u * s
                    moved = True
        if not moved:
            break
    return q


def _seqsum(a: np.ndarray) -> float:
    # left-to-right like locfit's loops (np.sum is pairwise)
    return float(np.cumsum(a)[-1]) if len(a) else 0.0


def _locfit_fit(x: np.ndarray, y: np.ndarray, w: np.ndarray, kw: np.ndarray, x0: float):
    """One local (or global) Gaussian fit at ``x0`` over the points ``x, y`` (prior weights
    ``w``, kernel weights ``kw``, in locfit's order).

    locfit starts at the weighted mean (``reginit``) and takes one Newton step (``max_nr``
    stops after it for the Gaussian family), solving ``X'WX d = X'W r`` through the eigen
    decomposition of the correlation-scaled ``X'WX`` (``JAC_EIGD``).  Components with an
    eigenvalue <= 1e-8 times the largest are not divided (``eig_solve``), which regularizes
    fits on fewer than three distinct points and nearly collinear ones.  Returns None when
    no point has weight (``LF_NOPT``: locfit then keeps the previous coefficients).
    """
    s1 = _seqsum(kw * (w * y))
    s0 = _seqsum(kw * w)
    if s0 == 0:
        return None
    c0 = s1 / s0
    dx = x - x0
    basis = (np.ones_like(dx), dx, dx * dx / 2)
    zd = w * (y - c0)
    c = kw * w
    f1 = [_seqsum(basis[j] * kw * zd) for j in range(3)]
    z = [_seqsum(c * basis[j] * basis[k]) for j in range(3) for k in range(3)]
    dg = [0.0 if z[j * 4] <= 0 else 1 / math.sqrt(z[j * 4]) for j in range(3)]
    for j in range(3):
        for k in range(3):
            z[j * 3 + k] *= dg[j] * dg[k]
    q = _locfit_eig_dec(z)
    tol = 1.0e-8 * max(z[0], z[4], z[8])
    v = [f1[j] * dg[j] for j in range(3)]
    wk = [0.0, 0.0, 0.0]
    for j in range(3):
        for k in range(3):
            wk[j] += q[k * 3 + j] * v[k]
        if z[j * 4] > tol:
            wk[j] /= z[j * 4]
    coef = [c0, 0.0, 0.0]
    for j in range(3):
        d = 0.0
        for k in range(3):
            d += q[j * 3 + k] * wk[k]
        coef[j] += d * dg[j]
    return coef


def _local_fit(means: np.ndarray, disps: np.ndarray, query: np.ndarray, *, alpha: float = 0.7,
               cut: float = 0.8) -> np.ndarray:
    """localDispersionFit: ``locfit(log(disp) ~ log(mean), weights = mean)``, then predict.

    locfit's defaults: local quadratic (basis 1, dx, dx^2 / 2), tricube kernel,
    nearest-neighbour bandwidth covering ``alpha`` = 70% of the points (prior weights do
    not enter the bandwidth), the global weighted quadratic as parametric component,
    evaluated on an adaptive tree over the data range (a cell is halved while its width
    exceeds ``cut`` times the smaller positive vertex bandwidth) and interpolated with cubic
    Hermite polynomials from the vertex values and slopes of the residual from the
    parametric component; beyond the data range that residual is continued linearly.  The
    arithmetic follows locfit 1.5-9.12's C source step by step (sequential sums, its Jacobi
    solver), because fits on a handful of points are degenerate or nearly so and the result
    depends on how locfit regularizes them (``_locfit_fit``); a vertex without points keeps
    the previous vertex's fit.  Like locfit this raises "newsplit: out of vertex space" when
    the tree needs more than its 2 * floor(5 / (alpha * cut) + 1) vertices (ties that make
    the bandwidth 0, for instance).
    """
    keep = disps >= MIN_DISP * 10
    if not keep.any():
        return np.full(len(query), MIN_DISP)
    x = np.log(means[keep])
    yv = np.log(disps[keep])
    w0 = means[keep]
    n = len(x)
    # the floor(n * alpha)-th nearest point; locfit adds 1e-12 so that 90 * 0.7 = 62.999…
    # counts as 63
    nn = int(math.floor(n * alpha + 1e-12))
    max_vertices = int((5 * (1 / alpha) / min(1.0, cut) + 1) * 2)  # atree_guessnv
    ordered = bool(np.all(x[1:] >= x[:-1]))
    lo, hi = float(x.min()), float(x.max())
    xbar = _seqsum(x * w0) / _seqsum(w0)
    # parametric component: the global quadratic, centred at the weighted mean
    pc = _locfit_fit(x, yv, w0, np.ones(n), xbar)

    def pc_value(x1):
        dx = x1 - xbar
        return pc[0] * 1.0 + pc[1] * dx + pc[2] * (dx * dx / 2)

    last = [pc]

    def vertex(x0: float) -> Tuple[float, float, float]:
        # fit at a vertex: value and slope minus the parametric component, bandwidth
        d = np.abs(x - x0)
        h = float(np.partition(d, nn - 1)[nn - 1]) if nn >= 1 else 0.0

        def kernel(di):
            if h == 0:
                return np.where(di == 0, 1.0, 0.0)
            u = di / h
            t = 1 - u * u * u
            return np.where(u > 1, 0.0, t * t * t)

        if ordered:
            # nbhd1: walk left from the closest point, then right, while weights are > 0
            if x0 <= x[0]:
                zc = 0
            elif x0 >= x[n - 1]:
                zc = n - 1
            else:
                r = int(np.searchsorted(x, x0, side="right"))
                l = r - 1
                zc = r if (x0 - x[l]) > (x[r] - x0) else l
            if x[zc] > x0:
                zc -= 1
            left = kernel(x0 - x[zc::-1]) if zc >= 0 else np.zeros(0)
            right = kernel(x[zc + 1:] - x0)
            nl = int(np.argmax(~(left > 0))) if not np.all(left > 0) else len(left)
            nr = int(np.argmax(~(right > 0))) if not np.all(right > 0) else len(right)
            idx = np.concatenate([np.arange(zc, zc - nl, -1), np.arange(zc + 1, zc + 1 + nr)]).astype(int)
            kw = np.concatenate([left[:nl], right[:nr]])
        else:
            wt = kernel(d)
            idx = np.nonzero(wt > 0)[0]
            kw = wt[idx]
        coef = _locfit_fit(x[idx], yv[idx], w0[idx], kw, x0) or last[0]
        last[0] = coef
        slope = pc[0] * 0.0 + pc[1] * 1.0 + pc[2] * (x0 - xbar)
        return coef[0] - pc_value(x0), coef[1] - slope, h

    vx = [lo, hi]
    vf = [vertex(lo), vertex(hi)]

    def needs_split(a: int, b: int) -> bool:
        # atree_split: wider than cut times the smallest positive vertex bandwidth (40% of
        # the range when no vertex has one)
        hmin = 0.0
        for h in (vf[a][2], vf[b][2]):
            if h > 0 and (hmin == 0 or h < hmin):
                hmin = h
        if hmin == 0:
            # all x tied: 0 / 0 in C, never split
            return hi > lo and cut < 2 * (vx[b] - vx[a]) / (hi - lo)
        return cut < (vx[b] - vx[a]) / hmin

    # atree_grow: depth first, left half first (the order matters when a vertex has no
    # points and inherits the previous fit); tree nodes are cells (a, b)
    cells = [(0, 1)]
    kids = {}

    def grow(node: int) -> None:
        a, b = cells[node]
        if not needs_split(a, b):
            return
        if len(vx) == max_vertices:
            raise ValueError("local dispersion fit failed (locfit: newsplit: out of vertex space)")
        vx.append((vx[a] + vx[b]) / 2)
        vf.append(vertex(vx[-1]))
        m = len(vx) - 1
        cells.extend([(a, m), (m, b)])
        kids[node] = (len(cells) - 2, len(cells) - 1)
        grow(kids[node][0])
        grow(kids[node][1])

    grow(0)
    lq = np.log(query)
    # atree_int: descend to the cell; outside the data range that is the edge cell
    ca = np.array([vx[a] for a, _ in cells])
    cb = np.array([vx[b] for _, b in cells])
    kid_lo = np.array([kids.get(c, (c, c))[0] for c in range(len(cells))])
    kid_hi = np.array([kids.get(c, (c, c))[1] for c in range(len(cells))])
    node = np.zeros(len(lq), dtype=int)
    for _ in range(len(cells)):
        inner = kid_lo[node] != node
        if not inner.any():
            break
        go_left = 2 * (lq - ca[node]) < cb[node] - ca[node]
        node = np.where(inner, np.where(go_left, kid_lo[node], kid_hi[node]), node)
    va, vb = ca[node], cb[node]
    vfa = np.array(vf)
    fa = vfa[[cells[c][0] for c in range(len(cells))]][node]
    fb = vfa[[cells[c][1] for c in range(len(cells))]][node]
    # rectcell_interp / hermite2: cubic inside the cell, linear beyond the data range
    length = vb - va
    with np.errstate(all="ignore"):
        t = (lq - va) / length
    p1 = t * t * (3 - 2 * t)
    phi0 = np.where(t < 0, 1.0, np.where(t > 1, 0.0, 1 - p1))
    phi1 = np.where(t < 0, 0.0, np.where(t > 1, 1.0, p1))
    phi2 = np.where(t < 0, t, np.where(t > 1, 0.0, t * (1 - t) * (1 - t)))
    phi3 = np.where(t < 0, 0.0, np.where(t > 1, t - 1, t * t * (t - 1)))
    flat = length == 0
    phi0, phi1, phi2, phi3 = (np.where(flat, 1.0, phi0), np.where(flat, 0.0, phi1),
                              np.where(flat, 0.0, phi2), np.where(flat, 0.0, phi3))
    phi2 = phi2 * length
    phi3 = phi3 * length
    val = phi0 * fa[:, 0] + phi1 * fb[:, 0] + phi2 * fa[:, 1] + phi3 * fb[:, 1]
    return np.exp(val + pc_value(lq))


# --- the whole test --------------------------------------------------------------

def deseq_two_conditions(counts: np.ndarray, condition_one: Sequence[bool], *, alpha: float = 0.01,
                         cooks_cutoff: bool = True) -> Dict[str, np.ndarray]:
    """DESeq() then results(contrast = one vs two, alpha) on an integer matrix.

    ``counts`` is rows x samples (already filtered); ``condition_one[j]`` says
    whether sample ``j`` belongs to condition_one.  log2FoldChange is
    condition_one over condition_two, as in ``DESeq_run.R``.
    """
    y = np.ascontiguousarray(counts, dtype=np.float64)
    nrow, m = y.shape
    one = np.asarray(condition_one, dtype=bool)
    if one.sum() < 1 or (~one).sum() < 1 or m < 3:
        raise ValueError("need samples in both conditions and at least three in total")
    # factor levels sort alphabetically: condition_one is the reference level
    group = np.where(one, 0, 1).astype(np.int64)
    x = np.column_stack([np.ones(m), (~one).astype(float)])
    p = 2

    # size factors
    with np.errstate(divide="ignore"):
        logy = np.log(y)
    loggeo = logy.mean(axis=1)
    sf = np.empty(m)
    finite = np.isfinite(loggeo)
    for j in range(m):
        use = finite & (y[:, j] > 0)
        sf[j] = math.exp(float(np.median(logy[use, j] - loggeo[use]))) if use.any() else math.nan
        if not (math.isfinite(sf[j]) and sf[j] > 0):
            # estimateSizeFactorsForMatrix: "every gene contains at least one zero"
            raise ValueError("every cell has a zero count in at least one sample, so size factors (log geometric "
                             "means) cannot be computed; check that every sample has hybrids for this RNA pair")
    nf = np.broadcast_to(sf, y.shape)
    norm = y / sf
    base_mean = norm.mean(axis=1)
    base_var = norm.var(axis=1, ddof=1)

    # gene-wise dispersion
    group_means = np.column_stack([norm[:, group == g].mean(axis=1) for g in range(2)])
    lin = group_means[:, group]
    xim = float(np.mean(1.0 / sf))
    with np.errstate(divide="ignore", invalid="ignore"):
        moments = (base_var - xim * base_mean) / base_mean ** 2
        mu1 = np.maximum(1.0, lin)
        rough = np.maximum(np.sum(((norm - mu1) ** 2 - mu1) / mu1 ** 2, axis=1) / (m - p), 0.0)
    max_disp = max(10.0, m)
    alpha_init = np.clip(np.minimum(rough, moments), MIN_DISP, max_disp)
    mu = np.maximum(lin * sf, MIN_MU)
    zeros = np.zeros(nrow)
    la, iters, init_lp, last_lp = _fit_disp(y, mu, group, 2, np.log(alpha_init), zeros, 1.0, False,
                                            math.log(MIN_DISP / 10))
    disp_gene = np.minimum(np.exp(la), max_disp)
    no_increase = last_lp < init_lp + np.abs(init_lp) / 1e6
    disp_gene[no_increase] = alpha_init[no_increase]
    conv = (iters < MAXIT) & (iters != 1)
    refit = ~conv & (disp_gene > MIN_DISP * 10)
    if refit.any():
        disp_gene[refit] = _grid_refit(y[refit], mu[refit], group, 2, zeros[refit], 1.0, False, m)
    disp_gene = np.clip(disp_gene, MIN_DISP, max_disp)

    # trend
    use_fit = disp_gene > 100 * MIN_DISP
    if not use_fit.any():
        # estimateDispersionsFit stops here
        raise ValueError("all gene-wise dispersion estimates are within 2 orders of magnitude from the minimum "
                         "value, and so the standard curve fitting techniques will not work")
    try:
        coefs = _parametric_fit(base_mean[use_fit], disp_gene[use_fit])
        disp_fit = coefs[0] + coefs[1] / base_mean
        fit_type = "parametric"
    except (ValueError, FloatingPointError, ZeroDivisionError):
        # DESeq2: "the dispersion trend was not well captured by the function
        # y = a/x + b, and a local regression fit was automatically substituted"
        coefs = np.array([np.nan, np.nan])
        disp_fit = _local_fit(base_mean[use_fit], disp_gene[use_fit], base_mean)
        fit_type = "local"
    resid = np.log(disp_gene) - np.log(disp_fit)
    above = disp_gene >= MIN_DISP * 100
    var_log_disp = _mad(resid[above]) ** 2
    df = m - p
    if df <= 3:
        prior_var = _prior_var_few_df(resid[above], df)
    else:
        prior_var = max(var_log_disp - trigamma(df / 2.0), 0.25)

    # MAP
    disp_init = np.where(disp_gene > 0.1 * disp_fit, disp_gene, disp_fit)
    la, iters, _, _ = _fit_disp(y, mu, group, 2, np.log(disp_init), np.log(disp_fit), prior_var, True,
                                math.log(MIN_DISP / 10))
    disp_map = np.exp(la)
    refit = iters >= MAXIT
    if refit.any():
        disp_map[refit] = _grid_refit(y[refit], mu[refit], group, 2, np.log(disp_fit[refit]), prior_var, True, m)
    disp_map = np.clip(disp_map, MIN_DISP, max_disp)
    outlier = np.log(disp_gene) > np.log(disp_fit) + 2.0 * math.sqrt(var_log_disp)
    disp = np.where(outlier, disp_gene, disp_map)

    # Wald test
    q, r = np.linalg.qr(x)
    beta0 = np.linalg.solve(r, q.T @ np.log(norm + 0.1).T).T
    lam = np.full(p, LAMBDA / math.log(2) ** 2)
    beta, var, hat, biters = _fit_beta(y, np.ascontiguousarray(nf), x, disp, np.ascontiguousarray(beta0), lam)
    beta2 = beta / math.log(2)  # log2 scale, as DESeq2 reports
    se2 = np.sqrt(np.maximum(var, 0.0)) / math.log(2)
    conv = biters < MAXIT
    stable = np.all(np.isfinite(beta), axis=1)
    for i in np.where(~conv | ~stable | ~np.all(var > 0, axis=1))[0]:
        start = beta2[i] if stable[i] and np.all(np.abs(beta2[i]) < LARGE) else beta0[i]
        beta2[i], se2[i], conv[i] = _optim_row(y[i], sf, x, disp[i], start)
    lfc = -beta2[:, 1]
    se = se2[:, 1]
    stat = lfc / se
    pvalue = 2.0 * _norm_sf(np.abs(stat))

    # Cook's distance (cells with 3 or more replicates)
    max_cooks = np.full(nrow, np.nan)
    sizes = np.bincount(group, minlength=2)
    big_cells = [g for g in range(2) if sizes[g] >= 3]
    if cooks_cutoff and big_cells:
        mu_fit = sf * np.exp2(x @ beta2.T).T
        v = np.zeros(nrow)
        for g in big_cells:
            cell = norm[:, group == g]
            n = cell.shape[1]
            trim, scale = (1 / 3, 2.04) if n <= 3.5 else ((1 / 4, 1.86) if n <= 23.5 else (1 / 8, 1.51))
            cm = _trimmed_mean(cell, trim)
            v = np.maximum(v, scale * _trimmed_mean((cell - cm[:, None]) ** 2, trim))
        mean_all = norm.mean(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            rdisp = np.maximum((v - mean_all) / mean_all ** 2, 0.04)
        pear = (y - mu_fit) ** 2 / (mu_fit + rdisp[:, None] * mu_fit ** 2)
        cooks = pear / p * hat / (1.0 - hat) ** 2
        in_big = np.isin(group, big_cells)
        max_cooks = cooks[:, in_big].max(axis=1)
        cutoff = _qf99(p, m - p)
        flagged = np.where(max_cooks > cutoff)[0]
        keep = np.zeros(len(flagged), dtype=bool)
        for k, ii in enumerate(flagged):
            out_count = y[ii, int(np.argmax(cooks[ii]))]
            keep[k] = int(np.sum(y[ii] > out_count)) >= 3
        pvalue[flagged[~keep]] = np.nan

    padj, threshold = _independent_filtering(base_mean, pvalue, alpha)
    return {
        "baseMean": base_mean, "log2FoldChange": lfc, "lfcSE": se, "stat": stat, "pvalue": pvalue,
        "padj": padj, "dispGeneEst": disp_gene, "dispFit": disp_fit, "dispersion": disp,
        "maxCooks": max_cooks, "sizeFactors": sf, "dispPriorVar": prior_var,
        "varLogDispEsts": var_log_disp, "trend": coefs, "fitType": fit_type, "filterThreshold": threshold,
        "betaConv": conv,
    }


def _optim_row(k, nf, x, alpha, start):
    """fitNbinomGLMsOptim for one row: penalized NB fit on the log2 scale.

    R calls ``optim(method="L-BFGS-B", lower=-30, upper=30)``; this does
    projected Fisher scoring on the same objective, which reaches the same
    optimum to within optim's tolerance.
    """
    ln2 = math.log(2)
    r = 1.0 / alpha
    lam = np.full(x.shape[1], LAMBDA)

    def objective(b):
        mu = nf * np.exp2(x @ b)
        ll = np.sum([_dnbinom_log(float(kj), r, float(mj)) for kj, mj in zip(k, mu)])
        val = -(ll - 0.5 * np.sum(lam * b * b))
        return val if math.isfinite(val) else 1e300

    b = np.clip(np.asarray(start, dtype=float), -LARGE, LARGE)
    f = objective(b)
    converged = False
    for _ in range(200):
        mu = nf * np.exp2(x @ b)
        grad = -(ln2 * x.T @ (r * (k - mu) / (r + mu))) + lam * b
        info = ln2 ** 2 * (x.T * (mu * r / (r + mu))) @ x + np.diag(lam)
        try:
            step = np.linalg.solve(info, grad)
        except np.linalg.LinAlgError:
            step = grad
        t = 1.0
        while True:
            cand = np.clip(b - t * step, -LARGE, LARGE)
            fc = objective(cand)
            if fc <= f or t < 1e-10:
                break
            t /= 2
        moved = np.max(np.abs(cand - b))
        b, f_old, f = cand, f, fc
        if abs(f_old - f) <= 1e-12 * (abs(f) + 1e-12) or moved < 1e-10:
            converged = True
            break
    mu = np.maximum(nf * np.exp2(x @ b), MIN_MU)
    w = mu / (1.0 + alpha * mu)
    xtwx = (x.T * w) @ x
    inv = np.linalg.inv(xtwx + np.diag(lam / ln2 ** 2))
    sigma = inv @ xtwx @ inv
    return b, np.sqrt(np.maximum(np.diag(sigma), 0.0)) / ln2, converged


def _trimmed_mean(a: np.ndarray, trim: float) -> np.ndarray:
    n = a.shape[1]
    lo = int(math.floor(n * trim))
    if lo == 0:
        return a.mean(axis=1)
    s = np.sort(a, axis=1)
    return s[:, lo:n - lo].mean(axis=1)


def _qf99(d1: int, d2: int) -> float:
    if d1 == 2:  # F(2, d2) has a closed-form quantile
        return d2 / 2.0 * (0.01 ** (-2.0 / d2) - 1.0)
    raise NotImplementedError("only two-condition designs are supported")


def _independent_filtering(filt: np.ndarray, pvalue: np.ndarray, alpha: float):
    lower = float(np.mean(filt == 0))
    upper = 0.95 if lower < 0.95 else 1.0
    theta = np.linspace(lower, upper, 50)
    cutoffs = _quantile7(filt, theta)
    padjs = []
    for c in cutoffs:
        use = filt >= c
        adj = np.full(len(filt), np.nan)
        if use.any():
            adj[use] = p_adjust_bh(pvalue[use])
        padjs.append(adj)
    num_rej = np.array([np.sum(a < alpha) for a in padjs], dtype=float)
    fit = lowess(theta, num_rej, f=1 / 5)
    if num_rej.max() <= 10:
        j = 0
    else:
        pos = num_rej > 0
        residual = (num_rej[pos] - fit[pos]) if pos.any() else np.zeros(1)
        thresh = fit.max() - math.sqrt(float(np.mean(residual ** 2)))
        j = 0
        for level in (thresh, 0.9 * fit.max(), 0.8 * fit.max()):
            over = np.where(num_rej > level)[0]
            if len(over):
                j = int(over[0])
                break
    return padjs[j], float(cutoffs[j])
