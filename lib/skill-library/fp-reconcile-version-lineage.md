# Reconcile Version Lineage

Use this method to trace missing work across source, builds, releases, and installed artifacts. Compare labels, ancestry, content, and runtime identity separately; each supports a different claim about which behavior is present.

## Primitives

Record the independently accepted baseline, candidate commit, parent graph, patch content, build configuration, dependency lockfiles, artifact hash, installation path, and running process identity. Distinguish source present, source built, artifact installed, and code currently executing. Preserve uncommitted work and unrelated branches during inspection.

## Procedure

1. Identify the expected development baseline from existing release or integration evidence. Do not pick the candidate itself as the baseline merely because it is convenient.
2. Read the candidate's actual commit and ancestry. Determine whether the baseline is an ancestor, whether branches diverged, and which commits appear unique to each side.
3. Compare content for important changes. Cherry-picks and rebases can preserve a patch without preserving ancestry; later edits can reverse behavior even when the original commit is an ancestor.
4. Check build inputs and manifests against the source candidate. Bind the packaged artifact to its build record or measured hash rather than a filename containing a version number.
5. Inspect the installed location and running application identity. An updated installer on disk is not proof that the running process loaded it.
6. Create a retained, missing, superseded, and unresolved change inventory. For each missing behavior, identify the first point where expected content leaves the chain.
7. Recover through the project's existing integration workflow. Preserve current updates as well as the accepted baseline. Follow existing release acknowledgement rules where they apply; this reasoning method does not invent a new publication gate.
8. Verify the repaired source and artifact identities at the boundary relevant to the user's request.

## Worked example

Release 1.9 contains feature A. A maintainer builds version 2.0 from an older branch plus feature B. Comparing labels suggests an upgrade; the parent graph shows divergence. A content check confirms that A is absent and B is present. The repair integrates both changes into an appropriate descendant, then binds the resulting build to its artifact. Reinstalling the same 2.0 artifact cannot restore A.

## Output and check

Return the identity chain, missing-change inventory, exact divergence point, and observed repaired behavior. Clearly distinguish verified content from a plausible explanation supported only by timestamps.

## Failure boundary

An ancestry failure can be legitimate after a rebase or intentional branch release. An ancestry pass can still contain a revert. Neither condition independently establishes correctness. Avoid destructive resets, broad cleanup, or version bumping as substitutes for reconciling the actual changes.

## Reference

- [Git: merge-base and ancestry checks](https://git-scm.com/docs/git-merge-base)
