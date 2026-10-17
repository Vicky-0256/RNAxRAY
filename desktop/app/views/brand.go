package views

// The RNAxRay wordmark of the web app (web/assets/rnaxray-wordmark*.svg,
// copied here from docs/brand/RNAxRay-SVG/01-字标; desktop/scripts/make-icon.py
// renders the app icon from the same set).

import (
	_ "embed"
	"runtime"

	"github.com/egoist/mygo/ui"
)

var (
	//go:embed assets/rnaxray-wordmark.svg
	logoSVG []byte
	//go:embed assets/rnaxray-wordmark-dark.svg
	logoDarkSVG []byte

	logoLight = ui.MustParseSVG(logoSVG)
	logoDark  = ui.MustParseSVG(logoDarkSVG)
)

// logoAspect is the wordmark's width / height (its viewBox, 1940 x 389.67).
const logoAspect = 1940 / 389.67

// The RNAxRay accent of the web app (web/styles.css --teal, --teal-deep,
// --primary-hover, --primary-foreground and, for text, --primary-ink),
// replacing MyGo's blue and the system's accent color.
var (
	brandTeal      = ui.Hex("#00a09d")
	brandTealDeep  = ui.Hex("#007b78")
	brandNavy      = ui.Hex("#10263d")
	brandInkLight  = ui.Hex("#007672")
	brandInkDark   = ui.Hex("#35c3c0")
	brandHoverLite = ui.Hex("#00b0ac")
)

// The navy-tinted neutrals of the web app, light and dark (web/styles.css
// --surface, --canvas, --surface-subtle, --line, --ink, --muted and the
// status colors). Background is the web's card surface (cards, sidebar,
// top bar), Surface its subtle surface (controls, insets) and brandCanvas
// the page behind the cards.
var (
	brandLight = brandNeutrals{
		background: ui.Hex("#ffffff"), canvas: ui.Hex("#f3f7f8"), soft: ui.Hex("#e3f7f6"),
		surface: ui.Hex("#f3f7f8"), surfaceHover: ui.Hex("#e9f1f3"), surfacePressed: ui.Hex("#dce7ec"),
		border: ui.Hex("#dce7ec"), text: ui.Hex("#132c47"), textMuted: ui.Hex("#5b6c80"),
		danger: ui.Hex("#b42318"), warning: ui.Hex("#9c5e12"), success: ui.Hex("#007b78"),
		mutedStrong: ui.Hex("#38516a"), dangerSoft: ui.Hex("#fcecea"), warningSoft: ui.Hex("#fff4e3"),
	}
	brandDark = brandNeutrals{
		background: ui.Hex("#132c47"), canvas: ui.Hex("#0c1a29"), soft: ui.Hex("#123f4b"),
		surface: ui.Hex("#183650"), surfaceHover: ui.Hex("#21405e"), surfacePressed: ui.Hex("#2e4b66"),
		border: ui.Hex("#2e4b66"), text: ui.Hex("#ecf1f8"), textMuted: ui.Hex("#9eb1c3"),
		danger: ui.Hex("#f29c96"), warning: ui.Hex("#f5b867"), success: ui.Hex("#43d1b0"),
		mutedStrong: ui.Hex("#c8d6e2"), dangerSoft: ui.Hex("#4a2524"), warningSoft: ui.Hex("#4a3518"),
	}
)

type brandNeutrals struct {
	background, canvas, soft              ui.Color
	surface, surfaceHover, surfacePressed ui.Color
	border, text, textMuted               ui.Color
	danger, warning, success              ui.Color
	mutedStrong, dangerSoft, warningSoft  ui.Color
}

func brandOf(t *ui.Theme) *brandNeutrals {
	if t.Dark {
		return &brandDark
	}
	return &brandLight
}

// applyBrandTheme gives the frame's theme (light or dark as the system is,
// with its contrast and text size preferences) the RNAxRay colors.
func applyBrandTheme(c *ui.Context) {
	t := *c.Theme()
	n := brandOf(&t)
	t.Background, t.Surface, t.SurfaceHover, t.SurfacePressed = n.background, n.surface, n.surfaceHover, n.surfacePressed
	t.Border, t.Text, t.TextMuted = n.border, n.text, n.textMuted
	t.Danger, t.Warning, t.Success = n.danger, n.warning, n.success
	t.Accent, t.AccentPressed, t.AccentText = brandTeal, brandTealDeep, brandNavy
	if t.Dark {
		t.AccentHover = brandInkDark
		t.Selection, t.Focus = brandTeal.Alpha(0.4), brandInkDark.Alpha(0.6)
	} else {
		t.AccentHover = brandHoverLite
		t.Selection, t.Focus = brandTeal.Alpha(0.25), brandTeal.Alpha(0.55)
	}
	// What MyGo's own theme does for Increase Contrast, on these colors.
	if c.Preferences().HighContrast {
		t.Border = t.Border.Mix(t.Text, 0.45)
		t.TextMuted = t.TextMuted.Mix(t.Text, 0.4)
		t.Focus.A = 255
	}
	c.SetTheme(&t)
}

// brandCanvas is the page behind the cards (web --canvas).
func brandCanvas(t *ui.Theme) ui.Color { return brandOf(t).canvas }

// brandSoft is the light teal of a chosen item (web --primary-soft).
func brandSoft(t *ui.Theme) ui.Color { return brandOf(t).soft }

// Tones of a notice.
const (
	noticeInfo = iota
	noticeWarning
	noticeError
)

// notice is the web app's .notice: a tinted, bordered box for what a page
// says about itself (neutral), a caveat (warning) or a failure (error). body
// draws its content; noticeInk is the color for its text.
func notice(c *ui.Context, tone int, body func()) ui.Element {
	t := c.Theme()
	n := brandOf(t)
	bg, border := t.Surface, t.Border
	switch tone {
	case noticeWarning:
		bg, border = n.warningSoft, t.Warning.Mix(t.Border, 0.72)
	case noticeError:
		bg, border = n.dangerSoft, t.Danger.Mix(t.Border, 0.6)
	}
	return ui.Column(c).Gap(6).Padding(10, 12).Radius(6).Background(bg).Border(1, border).Children(body)
}

// noticeInk is the text color of a notice of tone.
func noticeInk(t *ui.Theme, tone int) ui.Color {
	switch tone {
	case noticeWarning:
		return t.Warning
	case noticeError:
		return t.Danger
	}
	return brandOf(t).mutedStrong
}

// noticeText is a notice holding one paragraph.
func noticeText(c *ui.Context, tone int, text string) ui.Element {
	return notice(c, tone, func() { ui.Text(c, text).TextColor(noticeInk(c.Theme(), tone)) })
}

// baseFontSize is MyGo's text size at the system's usual setting.
var baseFontSize = func() float32 {
	if runtime.GOOS == "darwin" {
		return 13
	}
	return 14
}()

// ts is a font size of px at the usual text size, scaled as the theme's
// text is by the system's text size setting; px itself at the usual size.
func ts(c *ui.Context, px float32) float32 {
	return px * c.Theme().FontSize / baseFontSize
}

// brandInk is the accent for text, which plain teal is too light for on a
// light background.
func brandInk(t *ui.Theme) ui.Color {
	if t.Dark {
		return brandInkDark
	}
	return brandInkLight
}

// brandLink is ui.Link in the accent for text.
func brandLink(c *ui.Context, label string) ui.Element {
	return ui.Link(c, label, "").TextColor(brandInk(c.Theme()))
}

// Logo shows the RNAxRay logo height DIPs high, in the theme's variant.
func Logo(c *ui.Context, height float32) ui.Element {
	b := logoLight
	if c.Theme().Dark {
		b = logoDark
	}
	return ui.Image(c, b).Width(height * logoAspect).Height(height).Label("RNAxRay")
}
