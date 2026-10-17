/* RNAxRay Web: the Compare page's effect and similarity maps
 * (RNAxRayData.computeComparison) run in this worker so that a whole-genome
 * comparison (the ZIKV example: four datasets, ~840,000 10-nt cells) does
 * not hold the page.  page-data.js sends each dataset either as packed
 * records (DataProvider getContactRecords, binned here with the page's
 * buildContactBins) or as contact bins, and builds the cell objects from
 * the typed arrays this worker returns.
 *
 * in:  { input: prepareComparison().input, budget: getContactResourceBudget(),
 *        sources: [{ label, records: ContactRecords } | { label, bins: { ready, reason, x, y, count } }] }
 * out: { type: "progress", stage, done, total }
 *      { type: "done", packed: computeComparison() output (buffers transferred) }
 *      { type: "error", message }
 */
"use strict";

// the page passes ?build=<commit>; the scripts get the same query so a new
// release does not mix with cached copies
const BUILD_QUERY = self.location && self.location.search || "";
// analysis-data.js publishes window.RNAxRayData
self.window = self;
importScripts("./analysis-data.js" + BUILD_QUERY, "./data-provider.js" + BUILD_QUERY);

self.onmessage = function (event) {
  const message = event.data || {};
  const data = self.RNAxRayData;
  const sources = message.sources || [];
  try {
    if (message.budget) {
      data.setContactResourceBudget(message.budget);
    }
    const packed = data.computeComparison(message.input, function (index) {
      const source = sources[index] || {};
      self.postMessage({ type: "progress", stage: "Binning " + (source.label || "dataset " + (index + 1)), done: index, total: sources.length });
      const bins = source.bins || data.buildContactBins(self.RNAxRayProvider.unpackContactRecords(source.records), message.input.datasets[index].query);
      if (index === sources.length - 1) {
        self.postMessage({ type: "progress", stage: "Combining " + sources.length + " maps", done: sources.length, total: sources.length });
      }
      return bins;
    }, { effectOrder: true });
    self.postMessage({ type: "done", packed: packed }, data.comparisonTransfers(packed));
  } catch (error) {
    self.postMessage({ type: "error", message: error && error.message ? error.message : String(error) });
  }
};
