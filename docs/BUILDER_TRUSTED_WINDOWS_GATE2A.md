# Gate 2A: trusted Windows worker isolation foundation

**Scope:** source review and deterministic fixture checks only. This gate adds no launcher, executable worker path, runtime experiment, production authorization, or change to Gate 1 admission. The native harness remains default disabled. The historical AO assignment is untouched.

## Inventory at the reviewed source boundary

| Capability | Status | Evidence and limit |
| --- | --- | --- |
| Creation-time Job list, suspended fixture, membership query, kill-on-close and one-process limit | Prototype | `native/disposable_job_harness.cpp` and `disposable_job_probe.cpp` implement these for one fixed disposable fixture. Native build was previously reported; the harness has not been run. Host support, nested Job behavior and cleanup are unverified. |
| Fixed fixture opt-in and default runtime denial | Implemented in source | `disposable_job_harness.cpp` requires a literal flag and a separately enabled build. No caller-selected command exists. This is not a production worker boundary. |
| Native claim parser and lifecycle transitions | Prototype | `nativeContainmentPrototype.ts` rejects malformed, stale and failed claims. All results remain unauthenticated and non-executable. |
| Filesystem path and metadata inspection | Prototype | `windowsFilesystemInspection.ts` performs Node read-only inspection; `windowsFilesystemPreflight.ts` checks lexical consistency. Neither holds protected handles or verifies effective ACLs. |
| Trusted runner controls and Gate 1 Builder scope | Prototype | `trustedRunnerPreflight.ts` and `builderTrustedExecution.ts` define claim and request contracts, with no trusted issuer, verifier, or executable adapter. |
| Restricted worker token, effective NTFS ACL, network isolation, executable handle pinning, durable STOP and descendant proof | Unverified or absent | No production implementation or independent Windows runtime evidence exists in this checkout. |

## Bounded change

`assessNativeWorkerIsolation` in the existing native claim model composes the existing native observation parser and filesystem identity assessor. It requires explicit claimed support for creation-time Job assignment, restricted token, handle inspection, effective ACL and network policy. It denies local readiness for absent Job membership, inherited control handle, native error, unavailable identity or restrictions, or unsafe filesystem status. Unknown and malformed fields fail closed. Even a complete claim returns `independentlyAuthenticated: false`, `productionAuthorized: false`, and `executable: false`, with `INDEPENDENT_CONTAINMENT_EVIDENCE_MISSING`. The function neither invokes the native probe nor supplies a launch authorization path. Its host booleans and receipt fields are caller claims, never proof.

The filesystem claim check accepts only a dense ordinary array of primitive component enum values with no accessors or extra properties, copies those values before inspection, and rejects conflicting root and candidate file IDs when the claimed resolved location is the same. These are consistency checks on caller data. Matching strings and IDs do not verify an OS handle, volume, reparse status or ACL.

The unused post-creation Job assignment helper was removed from `disposable_job_probe.cpp`. The native harness now has only its existing creation-time `PROC_THREAD_ATTRIBUTE_JOB_LIST` route; no suspended-process fallback is available in these sources.

## Windows guarantees still missing

- Administrator-provisioned, dedicated low-privilege worker SID and verified restricted token, integrity level, privileges, groups and inherited handles.
- Protected handle traversal, volume serial and file-ID binding, reparse-tag handling and replacement-race defense from workspace through executable creation; effective ACL denial outside the workspace.
- Independently checked network deny policy for the worker SID and every descendant; no inherited controller credentials or environment secrets.
- Verified creation-time Job membership on the target OS and nested Job hierarchy, enforced process/memory/CPU/runtime limits, no breakaway, descendant accounting and terminal cleanup after supervisor failure.
- Pinned executable bytes across inspection and process creation, with reviewed Codex invocation and bounded input/output.
- Authenticated, dispatch-bound native receipts, durable one-use grant and STOP ordering, independent lookup and recovery. Existing local claim formats lack provenance, process creation time, protected handle identity and binding to one dispatch.

## Independent runtime experiments required later

In a separately authorized disposable Windows environment, record OS/build, compiler and binary hashes, host Job hierarchy, SID/token details, ACL and network policy, and exact fixture identities. Test unsupported `PROC_THREAD_ATTRIBUTE_JOB_LIST`, nested Job failure, missing membership, inherited/duplicated control handles, child escape or breakaway, resource overrun, supervisor crash and uncertain cleanup. Separately test workspace and executable swap/reparse paths, out-of-workspace writes, secret reads and unapproved network from the worker and descendants. Capture independent OS evidence for each denial and for full process-tree termination. These experiments were not run for Gate 2A. No result from source tests or a native build substitutes for them.
