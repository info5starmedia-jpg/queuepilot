# Antivirus notes — QueuePilot self-built engine

QueuePilot ships a **self-compiled, unsigned** Chromium-based engine. That is
deliberate: the fingerprint protections are patched in at C++ level, and we do
not pay for a code-signing certificate for a family-and-friends build. The
downside is that antivirus products treat any new unsigned browser binary as
suspicious. This page is the fix.

## What you will see

| Product | Typical behavior |
| --- | --- |
| Windows SmartScreen | "Windows protected your PC" on first run of `setup.ps1` or `chrome.exe` → click **More info → Run anyway**. |
| Microsoft Defender | Usually quiet; may flag the zip as `PUA` (potentially unwanted). Exclusion below if it does. |
| Norton 360 | The aggressive one: silently quarantines `chrome.exe` ~15 minutes after first launch and then **name-locks the path**, so even a restored file gets deleted again. Exclusion is effectively mandatory. |
| Avast / AVG | "CyberCapture" upload-and-hold: the first launch stalls while the file is uploaded for analysis, then it runs. Subsequent launches fine, or add exclusion. |

None of this means the build is infected — it means it is **unknown**. The
binary is compiled from source on our own machine; the package's
`setup.ps1` verifies the payload SHA-256 before installing.

## Recommended fix: exclude the install directory

Add an exclusion for this folder (and only this folder):

```
%LOCALAPPDATA%\QueuePilot\engines
```

### Norton 360

1. Open Norton → **Settings → Antivirus → Scans and Risks**.
2. Under **Exclusions / Low Risks → Items to Exclude from Scans** → **Configure**.
3. Add the folder above.
4. Also add it under **Items to Exclude from Auto-Protect, Behavioral Protection (SONAR) and Download Intelligence**.
5. If `chrome.exe` was already quarantined: **Security → History → Quarantine → Restore**, *after* the exclusion is in place (otherwise it is deleted again).

### Microsoft Defender

1. **Windows Security → Virus & threat protection → Manage settings → Exclusions → Add or remove exclusions**.
2. **Add an exclusion → Folder** → the folder above.

### Avast / AVG

1. **Menu → Settings → General → Exceptions → Add Exception**.
2. Browse to the folder above.

## Why not just sign the binary?

A code-signing certificate costs money and ties the binary to a legal
identity. For a non-commercial build shared with family and friends, a
folder exclusion is the proportionate fix. If this build is ever distributed
more widely, buying a certificate and signing `chrome.exe` is the correct
next step — the build script supports it unchanged.

## If you are a developer reading this

The exclusion above covers the *installed* engine. On the **build machine**
you additionally want exclusions for the build tree (e.g. `C:\qe\src\out`)
and the checkout, or your hours-long link will be deleted minutes after it
finishes. (Learned the hard way — see `docs/build-plan.md`.)
