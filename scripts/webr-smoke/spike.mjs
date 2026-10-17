import { ChannelType, WebR } from "./webr-0.6.0/webr.mjs";

const output = document.getElementById("status");
const result = {
  ready: false,
  channel: "PostMessage",
  baseUrl: new URL("./webr-0.6.0/", window.location.href).href,
  rVersion: "",
  baseComputation: null,
  deseq2Available: null,
  error: ""
};
window.__spikeResult = result;

function show() {
  output.textContent = JSON.stringify(result, null, 2);
}

show();

try {
  const webR = new WebR({
    baseUrl: result.baseUrl,
    channelType: ChannelType.PostMessage,
    interactive: false
  });
  await webR.init();
  result.rVersion = await webR.evalRString("R.version.string");
  result.baseComputation = await webR.evalRNumber("sum(dpois(0:12, lambda = 4))");
  result.deseq2Available = await webR.evalRBoolean(
    '"DESeq2" %in% rownames(available.packages(repos = "https://repo.r-wasm.org/"))'
  );
  result.ready = true;
  show();
  webR.close();
} catch (error) {
  result.error = error && error.message ? error.message : String(error);
  show();
}
