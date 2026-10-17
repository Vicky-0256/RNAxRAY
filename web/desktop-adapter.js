/*
 * Boundary between the browser UI and the Tauri desktop shell.
 *
 * The web build remains functional without a native bridge: every method
 * reports "not handled" so callers fall back to the existing browser paths
 * (download links, Pyodide worker). In the desktop shell the same methods use
 * native dialogs and the bundled Python runtime.
 */
(function () {
  "use strict";

  var nativeBridge = window.__TAURI__ || null;
  var advertisedCapabilities = window.__RNAXRAY_DESKTOP_CAPABILITIES__ || (nativeBridge && nativeBridge.capabilities) || {};
  var invoke = nativeBridge && nativeBridge.core && nativeBridge.core.invoke;
  var desktopEnabled = typeof invoke === "function";

  function positiveInteger(value) {
    var parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || "");
        var comma = text.indexOf(",");
        resolve(comma >= 0 ? text.slice(comma + 1) : text);
      };
      reader.onerror = function () { reject(reader.error || new Error("Could not read the file contents.")); };
      reader.readAsDataURL(blob instanceof Blob ? blob : new Blob([blob == null ? "" : String(blob)]));
    });
  }

  var desktop = {
    enabled: desktopEnabled,
    nativeBridge: nativeBridge,
    // Runtime diagnostics are not proof that this Web controller dispatches
    // native jobs. Keep browser limits until the detector confirms them.
    advertisedCapabilities: advertisedCapabilities,
    capabilities: {
      cplfoldNative: desktopEnabled && advertisedCapabilities.cplfoldNative === true,
      numbaJit: desktopEnabled && advertisedCapabilities.numbaJit === true
    },
    limits: {
      // Native CPLfold sequence ceiling reported by runtime_detect
      // (structure.cplfold_native details.max_sequence_length). null means
      // unknown; callers then keep the browser ceiling.
      cplfoldMaxLength: desktopEnabled ? positiveInteger(advertisedCapabilities.cplfoldMaxLength) : null
    },
    // Resolves once runtime detection has finished (immediately on the web).
    ready: Promise.resolve(),
    /*
     * Returns true when the desktop handled the request (saved OR the user
     * cancelled the native dialog), so the caller must not also start a
     * browser download. Returns false only when no native dialog exists.
     */
    saveFile: async function (fileName, blob) {
      if (!desktopEnabled) return false;
      var data = await blobToBase64(blob);
      var result = await invoke("file_save_dialog", {
        request: { suggested_name: String(fileName || "download"), data_base64: data }
      });
      return !!(result && typeof result === "object" && typeof result.saved === "boolean");
    },
    openFile: async function () {
      // No generic native open dialog is exposed to analysis pages; project
      // inputs are imported through Project Home instead.
      return null;
    },
    startTask: async function () {
      throw new Error("Use the desktop Task Center to start native tasks.");
    },
    predictCplfold: async function (request) {
      if (!desktopEnabled) {
        return { ok: false, status: "unavailable", error: "The native task bridge is not available in this build." };
      }
      return invoke("cplfold_predict", { request: request || {} });
    }
  };
  window.RNAxRayDesktop = desktop;

  // Capability claims are opt-in. The desktop shell may not know them until
  // its runtime detector completes, so probe IPC once and promote only when
  // the detector explicitly reports an available native capability.
  if (desktopEnabled) {
    desktop.ready = Promise.resolve().then(function () {
      return invoke("runtime_detect");
    }).then(function (snapshot) {
      var list = (snapshot && snapshot.result && snapshot.result.capabilities) ||
        (snapshot && snapshot.capabilities) || [];
      var find = function (id) {
        for (var index = 0; index < list.length; index += 1) {
          if (list[index] && list[index].id === id) return list[index];
        }
        return null;
      };
      var native = find("structure.cplfold_native");
      var numba = find("structure.cplfold_numba");
      var before = JSON.stringify([desktop.capabilities, desktop.limits]);
      desktop.capabilities.cplfoldNative = !!(native && native.status === "available");
      desktop.capabilities.numbaJit = !!(numba && numba.status === "available");
      var details = native && native.details && typeof native.details === "object" ? native.details : {};
      desktop.limits.cplfoldMaxLength = positiveInteger(details.max_sequence_length) || desktop.limits.cplfoldMaxLength;
      if (JSON.stringify([desktop.capabilities, desktop.limits]) !== before) {
        if (typeof window.CustomEvent === "function") {
          window.dispatchEvent(new window.CustomEvent("rnaxray:desktop-capabilities", { detail: { capabilities: desktop.capabilities, limits: desktop.limits } }));
        }
        if (window.RNAxRayWeb && typeof window.RNAxRayWeb.refresh === "function") window.RNAxRayWeb.refresh();
      }
    }).catch(function () { /* Browser worker remains the safe fallback. */ });
  }
})();
