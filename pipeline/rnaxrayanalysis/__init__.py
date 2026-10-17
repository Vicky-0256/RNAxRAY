"""Analysis backend for .hyb files (contact maps, index, queries).

* :func:`coverage.write_contact` / :func:`coverage.write_for_table`: the
  ``rnaxray_coverage`` contact.txt and the ``rnaxray_compare`` forTable, byte-for-byte.
* :func:`index.build`: a per-sample SQLite index of a .hyb file.
* :mod:`query`: ``summary``, ``contact_bins``, ``hybrids``, ``top_interactions``
  over one or more indexes (replicates merged by summing), and
  ``compare_bins`` for two conditions on one shared bin grid.

Requires numpy; the import of ``rnaxraypipe.awk`` expects ``pipeline/`` on sys.path.
"""
from . import coverage, index, query
from .coverage import write_contact, write_for_table
from .index import build
from .query import compare_bins, contact_bins, hybrids, summary, top_interactions

__all__ = ["coverage", "index", "query", "write_contact", "write_for_table", "build",
           "summary", "contact_bins", "compare_bins", "hybrids", "top_interactions"]
__version__ = "0.1.0"
