#!/usr/bin/env bash
# Reference numbers for the included web example (web/example.js) from the
# original RNAxRay pipeline, for scripts/verify-example.cjs:
#
#   bash scripts/make-example-reference.sh <out-dir>
#   RNAXRAY_EXAMPLE_REFERENCE=<out-dir> node scripts/verify-example.cjs
#
# 1. one 10-nt contact map per replicate with rnaxray_coverage's command
#    (plot_hybrids_3.awk), then bin/rnaxray_compare (DESeq_run.R, -m 2 -r 100,
#    as reproduce_zikv/run_compare.sh ran compare_virion_AFR_vs_ILM);
# 2. the similarity heatmap as reproduce_zikv/analysis/run_similarity_rnaxray.sh:
#    replicates concatenated per lineage, binned, bins >= 10 kept,
#    plot_similarity_map on the two merged maps;
# 3. regions (select_regions_cplfold.py) and folding energies
#    (folding_energy.py, 2 x 40 nt, padj < 0.01) from reproduce_zikv/analysis,
#    with R's paired t.test.
#
# Needs R with DESeq2 (RNAXRAY_R_ENV, default ../.envs/rnaxray_r), the rnaxray conda
# env for RNAcofold / ggplot (RNAXRAY_ENV), and the reproduce_zikv folder
# (REPRODUCE_ZIKV, default ../reproduce_zikv) for the two analysis scripts and
# the CPLfold pairs tables.  RNAXRAY_BIN (default bin/ of this checkout) holds
# rnaxray_compare and friends; with BSD paste (macOS) rnaxray_compare needs
# "paste -sd '\t' -" for its table header, so point RNAXRAY_BIN at a checkout
# with that fix there.
set -euo pipefail

REPO="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$(mkdir -p -- "$1" && CDPATH= cd -- "$1" && pwd -P)"
R_ENV="${RNAXRAY_R_ENV:-$REPO/../.envs/rnaxray_r}"
RNAXRAY_ENV="${RNAXRAY_ENV:-/opt/homebrew/Caskroom/miniforge/base/envs/rnaxray_macOS-arm}"
ZIKV="$(CDPATH= cd -- "${REPRODUCE_ZIKV:-$REPO/../reproduce_zikv}" && pwd -P)"
EXAMPLE="$REPO/web/assets/examples/zikv-virion"
RNAXRAY_BIN="${RNAXRAY_BIN:-$REPO/bin}"
export PATH="$R_ENV/bin:$RNAXRAY_BIN:$RNAXRAY_ENV/bin:/usr/bin:/bin"

AFR=ZIKV_African_KX377335-1_virusRNA
ILM=ZIKV_FrenchPolynesian_KJ776791-2_virusRNA
work="$OUT/work"
mkdir -p "$work/compare" "$work/similarity"

# 1. rnaxray_compare
cd "$work/compare"
: > input.tsv
for entry in ZAFR_REP1:$AFR:condition_one ZAFR_REP2:$AFR:condition_one ZILM_REP2:$ILM:condition_two ZILM_REP3:$ILM:condition_two; do
    IFS=: read -r name gene condition <<< "$entry"
    gzip -dc "$EXAMPLE/${name}_1in10.hyb.gz" > "$name.hyb"
    plot_hybrids_3.awk USE_ENTIRE_HYBRIDS=1 BIN_SIZE=10 GENE_1=$gene GENE_2=$gene "$name.hyb" \
        | sed '2s/^/x\ty\tcount\n/' > "$name.$gene.contact.txt"
    printf '%s\t%s\t%s\n' "$name.hyb" "$name.$gene.contact.txt" "$condition" >> input.tsv
done
rnaxray_compare -i input.tsv -o sub -a $AFR -d "$EXAMPLE/ZAFR.fasta" > ../compare.log 2>&1
cp DESeq_sub_significant.padj_heatmap.txt sub_100range_pos_enrichment.txt sub_100range_neg_enrichment.txt "$OUT/"

# 2. similarity heatmap
cd "$work/similarity"
cat ../compare/ZAFR_REP1.hyb ../compare/ZAFR_REP2.hyb > ZAFR.hyb
cat ../compare/ZILM_REP2.hyb ../compare/ZILM_REP3.hyb > ZILM.hyb
for entry in ZAFR:$AFR ZILM:$ILM; do
    IFS=: read -r name gene <<< "$entry"
    plot_hybrids_3.awk USE_ENTIRE_HYBRIDS=1 BIN_SIZE=10 GENE_1=$gene GENE_2=$gene "$name.hyb" \
        | sed '2s/^/x\ty\tcount\n/' > "$name.contact.txt"
    awk -v m=10 'FNR <= 2 || $3 >= m' "$name.contact.txt" > "${name}_10.contact.txt"
done
plot_similarity_map -a ZAFR_10.contact.txt -i ZILM_10.contact.txt -p 0.95 > similarity.log 2>&1
awk '$1 ~ /^[0-9]+$/' ZAFR_10-ZILM_10.contact.txt | sed '1s/^/x\ty\tcount\n/' > "$OUT/sim_ZAFR_ZILM_min10.contact.txt"

# 3. regions and folding energies (the scripts read paths relative to reproduce_zikv)
cd "$ZIKV"
sed "s|^PRE = .*|PRE = '$work/compare/sub_100range_'|" analysis/select_regions_cplfold.py > "$work/select_regions.py"
python3 -I "$work/select_regions.py" "$OUT/regions.tsv" > /dev/null
python3 -I analysis/folding_energy.py "$work/compare/sub_100range" "$EXAMPLE/ZAFR.fasta" "$EXAMPLE/ZILM.fasta" \
    "$OUT/AFR_vs_ILM_sub.tsv" 0.01 40 > /dev/null

cd "$OUT"
Rscript -e 'd <- read.delim("sim_ZAFR_ZILM_min10.contact.txt"); cat("similarity cells", nrow(d), "cap", quantile(d$count, 0.95), "\n")
s <- read.delim("DESeq_sub_significant.padj_heatmap.txt"); cat("significant cells", nrow(s), "up", sum(s$log2FoldChange > 0), "\n")
for (side in c("pos", "neg")) { e <- read.delim(paste0("sub_100range_", side, "_enrichment.txt")); cat(side, "interactions", nrow(e), "padj < 0.01:", sum(e$padj < 0.01), "\n") }
d <- read.delim("AFR_vs_ILM_sub.tsv"); for (side in c("enriched_in_one", "enriched_in_two")) { x <- d[d$side == side, ]
  tt <- t.test(x$dG_one, x$dG_two, paired = TRUE); cat(side, "n", nrow(x), "t", sprintf("%.12g", tt$statistic), "p", sprintf("%.12g", tt$p.value), "\n") }'
cat regions.tsv
