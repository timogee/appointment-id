# Transcript fixtures

Real-shaped Indonesian conversations, replayed against `ScriptedChatModel` so the
suite is offline and deterministic.

These pin the **tool contract**, not the model's prose. What is asserted is which
tool ran with which arguments, and whether the thread handed off. The scripted
model supplies the model's side; the tools, the date parser, the escalation rules
and the database are all real.

To add one: drop a `.json` file here matching the `Transcript` type in
`tests/chat/transcript-replay.test.ts`. It is picked up automatically.
