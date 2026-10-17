RNAxRay Desktop: from raw chimeric reads (FASTQ) to hybrids, interactions and
RNA structure, on your own computer. Your data is not uploaded anywhere. The
only network use is the optional RNAcentral lookup, which is off until you
turn it on in Preferences.

## What's new in 0.1.4

- **RNAxRay**: the app, its files and its windows carry the RNAxRay name
  (formerly HYB2); projects made with earlier versions still open.
- **One look with RNAxRay Web**: the web app's teal and navy colors, in
  light and dark mode; cards on a light canvas, the chosen page in light
  teal, larger page titles.
- **Clearer messages**: failures and caveats appear in colored notices; the
  top bar shows "Local only" while external lookups are off.
- **Comparison colors** stay legible in dark mode, and values are marked
  with a condition dot instead of colored text.
- **Larger text**: the interface follows the system's text size setting.

## Download

| Computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `RNAxRay-Desktop-macOS-arm64.dmg` |
| Windows 10/11, 64-bit | `RNAxRay-Desktop-Windows-x64-Setup.exe` |
| Linux x86-64 (Debian/Ubuntu) | `RNAxRay-Desktop-Linux-x64.deb` |
| Linux x86-64 (other) | `RNAxRay-Desktop-Linux-x64.tar.gz` (run `install.sh`) |

`SHA256SUMS.txt` lists the checksum of every file.

## First launch

The app is not yet signed with an Apple or Microsoft developer certificate,
so the system asks you to confirm the first time you open it:

- **macOS**: open the .dmg and drag RNAxRay Desktop to Applications. Open it
  once. If macOS says it cannot verify the app, go to System Settings →
  Privacy & Security and click **Open Anyway**.
- **Windows**: if SmartScreen shows "Windows protected your PC", click
  **More info** and then **Run anyway**.

On first launch the app unpacks its bundled analysis runtime (Python with
NumPy, Numba and ViennaRNA, plus Bowtie2), which takes a few seconds. After
that it starts straight away and works offline.
