# Recording recovery

| Symptom | Next action |
| --- | --- |
| Connection unavailable | `screenstudio_status` explains it. The server finds the app's automation port by itself. If the app runs without one, the person quits it (Cmd+Q) and `screenstudio_launch` starts it again. The server never kills a running app. |
| Unsupported build | Keep the project intact. Use app UI through the host's computer controls or request adapter compatibility work. |
| Start timed out | Read session state. An active session means start succeeded. |
| Wrong window/focus changed | Stop input, screenshot and identify the original target again. |
| Waiting on network or reasoning | Pause, resolve the wait, inspect target, resume. |
| Finish timed out | Inspect session and project output before retrying. Preserve the project and report uncertainty. |
| App exited | Keep the unfinished recording. Reopen Screen Studio and use its recovery UI. |
| Lost export connection | Poll the same job after reconnecting. Export job metadata survives server restart; renderer state requires the app to remain open. |

Never infer recording success from a new directory alone. Finish must return a successful saved project. Keep the source until its rendered output has been inspected.
