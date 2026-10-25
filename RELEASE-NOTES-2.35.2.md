# BLACKICE 2.35.2

Planning catalog requests now project the small amount of run metadata they need directly from retained records. They no longer create complete snapshots of every retained conversation, including its events and outputs, before returning a page of plan summaries.

Conversation identity, ordering, titles, lifecycle states and active-run edit guards retain their existing behavior. Startup hardening and phase diagnostics from 2.35.1 remain in place. The original intermittent long startup remains under investigation; this fixes a separately measured Planning response cost.
