# RNAxRay Desktop task runner prototype

`runner.py` is a dependency-free prototype for the native task contract used
by the desktop shell. It accepts an argument array, never invokes a shell,
streams stdout/stderr as JSON events, and can terminate the complete child
process group.

Run a command:

```bash
python3 desktop/task-runner/runner.py -- python3 -c "print('hello')"
```

Run tests:

```bash
python3 -m unittest discover -s desktop/task-runner -p 'test_*.py'
```

The prototype will be replaced or embedded behind the desktop task scheduler (desktop/app/core) in P3. The
contract should remain stable: `started`, `log`, `completed`, `failed`, and
`cancelled` events contain a `taskId`; terminal events contain `exitCode`.
