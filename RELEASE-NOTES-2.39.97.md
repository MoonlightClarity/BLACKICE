# BLACKICE 2.39.97 candidate

Directory now rejects a tool callback when cancellation was already observed before dispatcher entry. This host-proven refusal reports that the action was not dispatched. Cancellation after a completed effect preserves its receipt; it does not reinterpret that effect as absent or replay it.

If a provider returns after cancellation, Directory no longer publishes that return as a completed phase. The saved work remains available for recovery. These checks cover two demonstrated cancellation boundaries, not every possible cancellation race.

Both targeted regressions failed on the 2.39.96 source and passed after the fix. The five-file focused run passed 89 tests without failures or skips. Exact Windows source, documentation, installer and publication checks remain release gates.

The experimental action Directory and derived index are not included. This candidate does not establish live-model efficiency, whole-startup performance or installed-runtime effectiveness. Existing application history and uncertain effects remain preserved.
