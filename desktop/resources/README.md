# Desktop release resources

Platform-specific CPython, NumPy, Numba, llvmlite and CPLfold files are
release inputs. They are intentionally ignored by Git because a staged
runtime is hundreds of megabytes and is different for each OS/architecture.

Before building an installer, place a verified runtime at
`desktop/resources/native/` and run:

```bash
python3 desktop/scripts/verify-native-release.py
```

The release gate rejects missing, non-portable, cross-platform, or modified
runtimes. The archive URL and SHA-256 are recorded in `native-manifest.json`.
