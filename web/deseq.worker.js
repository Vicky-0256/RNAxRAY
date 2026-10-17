/* RNAxRay Web: the differential contact test (deseq.js) runs in this
 * dedicated worker so a whole-genome table does not block the page.  The
 * per-row stages (dispersion fits, IRLS) are split over helper workers (this
 * same script) when the browser allows nested workers; rows are independent,
 * so the numbers do not depend on the split.
 *
 * in:  { samples: [{ name, arms: Int32Array [xStart, xEnd, yStart, yEnd]* }
 *                  | { name, x, y, count }], conditionOne: [bool],
 *        options: { minCount, radius, padjCutoff, binSize, helpers? } }
 * out: { type: "progress", stage, detail, fraction }
 *      { type: "done", result: { summary, significant, interactions } }
 *      { type: "error", message }
 * helper mode: in { type: "task", id, task } -> out { type: "taskDone", id, result }
 *      | { type: "tick", id, done } | { type: "taskError", id, message }
 */
// the page passes ?build=<commit>; deseq.js and the helpers get the same query
// so a new release does not mix with cached copies
const BUILD_QUERY = self.location && self.location.search || "";
importScripts("./deseq.js" + BUILD_QUERY);

const MAX_HELPERS = 8;

function helperCount(requested) {
  if (typeof Worker === "undefined") {
    return 0;
  }
  const cores = self.navigator && self.navigator.hardwareConcurrency || 2;
  const wanted = requested == null ? cores - 1 : requested;
  return Math.max(0, Math.min(MAX_HELPERS, wanted));
}

function runHelperTask(message) {
  const D = self.RNAxRayDeseq;
  let last = 0;
  try {
    const result = D.runTask(message.task, function (k) {
      if (k - last >= 8192) {
        last = k;
        self.postMessage({ type: "tick", id: message.id, done: k });
      }
    });
    self.postMessage({ type: "taskDone", id: message.id, result: result }, D.taskTransfers(result));
  } catch (error) {
    self.postMessage({ type: "taskError", id: message.id, message: error && error.message ? error.message : String(error) });
  }
}

// A pool of helper workers; run(task, onRows) resolves with the merged result.
function createPool(count) {
  const D = self.RNAxRayDeseq;
  const helpers = [];
  let nextId = 1;
  const pending = new Map();
  for (let i = 0; i < count; i += 1) {
    let helper;
    try {
      helper = new Worker("./deseq.worker.js" + BUILD_QUERY);
    } catch (error) {
      break;
    }
    helper.onmessage = function (event) {
      const message = event.data || {};
      const job = pending.get(message.id);
      if (!job) {
        return;
      }
      if (message.type === "tick") {
        job.onTick(message.done - job.done);
        job.done = message.done;
      } else if (message.type === "taskDone") {
        pending.delete(message.id);
        job.onTick(job.rows - job.done);
        job.resolve(message.result);
      } else if (message.type === "taskError") {
        pending.delete(message.id);
        job.reject(new Error(message.message));
      }
    };
    helper.onerror = function (event) {
      pending.forEach(function (job) { job.reject(new Error(event && event.message || "a helper worker stopped")); });
      pending.clear();
    };
    helpers.push(helper);
  }
  return {
    size: helpers.length,
    run: function (task, onTick) {
      const parts = D.splitTask(task, helpers.length);
      return Promise.all(parts.map(function (part, index) {
        return new Promise(function (resolve, reject) {
          const id = nextId;
          nextId += 1;
          pending.set(id, { resolve: resolve, reject: reject, rows: part.rows, done: 0, onTick: onTick });
          const transfer = part.transfer;
          delete part.transfer;
          helpers[index].postMessage({ type: "task", id: id, task: part }, transfer);
        });
      })).then(function (results) { return D.mergeTask(task, results); });
    },
    close: function () {
      helpers.forEach(function (helper) { helper.terminate(); });
    }
  };
}

self.onmessage = function (event) {
  const message = event.data || {};
  if (message.type === "task") {
    runHelperTask(message);
    return;
  }
  const started = Date.now();
  let last = 0;
  let lastStage = "";
  const progress = function (stage, detail, fraction) {
    const now = Date.now();
    if (now - last < 150 && stage === lastStage) {
      return;
    }
    last = now;
    lastStage = stage;
    self.postMessage({ type: "progress", stage: stage, detail: detail, fraction: fraction == null ? null : fraction });
  };
  let pool = null;
  const fail = function (error) {
    if (pool) {
      pool.close();
    }
    self.postMessage({ type: "error", message: error && error.message ? error.message : String(error) });
  };
  try {
    const D = self.RNAxRayDeseq;
    const options = message.options || {};
    const binSize = options.binSize || D.DEFAULTS.binSize;
    progress("bin", "binning contact cells", 0);
    const samples = (message.samples || []).map(function (sample) {
      return {
        name: sample.name,
        cells: sample.arms ? D.binArms(sample.arms, binSize) : D.cellsFromColumns(sample.x, sample.y, sample.count, binSize)
      };
    });
    const binMs = Date.now() - started;
    const helpers = helperCount(options.helpers);
    pool = helpers > 1 ? createPool(helpers) : null;
    if (pool && pool.size < 2) {
      pool.close();
      pool = null;
    }
    const runner = function (task) {
      if (!pool) {
        return D.runTask(task, function (k, total) { progress(task.stage, task.label, k / total); });
      }
      let done = 0;
      progress(task.stage, task.label, 0);
      return pool.run(task, function (rows) {
        done += rows;
        progress(task.stage, task.label, done / task.rows);
      });
    };
    D.compareAsync(samples, message.conditionOne, Object.assign({}, options, { progress: progress }), runner).then(function (result) {
      if (pool) {
        pool.close();
      }
      result.summary.timings.binMs = binMs;
      result.summary.timings.workerMs = Date.now() - started;
      result.summary.helperWorkers = pool ? pool.size : 0;
      result.summary.cellsPerSample = samples.map(function (sample) { return sample.cells.key.length; });
      const s = result.significant;
      self.postMessage({ type: "done", result: result }, [s.x.buffer, s.y.buffer, s.log2FoldChange.buffer, s.padj.buffer, s.baseMean.buffer]);
    }, fail);
  } catch (error) {
    fail(error);
  }
};
