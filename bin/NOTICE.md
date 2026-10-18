# Licence of the scripts in bin/

This directory holds the original command-line toolkit. Many of its scripts
are copies or modified versions of scripts from two GPL-3.0 projects:

- hyb (https://github.com/gkudla/hyb), Copyright (C) 2013 A.J. Travis,
  G. Kudla and J. Moody, GPL-3.0-or-later. For example `get_mtop_hybrids.pl`,
  `txt2hyb.awk`, `make_comp_fasta.pl`, `make_hyb_db_2`, `mtophits_blast`,
  `remove_duplicate_hits_blast.pl`, `remove_duplicate_hybrids_hOH5_2.pl`,
  `make_hybrid_annotation_table.pl`, `make_nicer_vienna_hOH5.awk`,
  `hybrid_stats_2`, `blast_stats_2`, `sam2blast_3`, `getseqs_sam`,
  `add_dG_hyb_2.pl`, `combine_hyb_merge`, `create_reference_file.pl`,
  `solexa2fasta.awk`, `Hybrid_long.pm`.
- comrades (https://github.com/gkudla/comrades), by Grzegorz Kudla and Marta
  Gabryelska, GPL-3.0. For example `comradesFold2`, `comradesMakeConstraints_2`,
  `Ct2B_GK_3.pl`, `Hybrid_long_2.pm`, `bp2hyb.sh`,
  `combine_hyb_merge_touching.pl`, `ct2bps_2.awk`, `fasta2tab.awk`,
  `histogram.pl`, `rnaxrayconstraints.pl`, `rnaxrayfasta_bits_allRNAs.awk`.

Because these scripts are combined into one toolkit, everything in this
directory is distributed under the GNU General Public License, version 3,
with the full text in `LICENSE`, except the three files below.

These are RNAxRay's own and are MIT licensed, like the rest of the
repository (top-level `LICENSE`):

- `cplfold`
- `README.md`
- `cplfold-python.md`
