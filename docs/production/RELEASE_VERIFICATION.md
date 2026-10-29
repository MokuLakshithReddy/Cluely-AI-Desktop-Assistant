# Windows Release Verification & Authenticode Security Guide

**Document Version**: 1.0.0  
**Release Version**: v1.0.1  
**Target Platform**: Microsoft Windows 10 / 11 (x64)  
**Binary Distribution**: `Cluely-Copilot-1.0.1-Windows-x64.exe`  
**GitHub Release URL**: [https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/releases/tag/v1.0.1](https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant/releases/tag/v1.0.1)

---

## 1. Release Artifact Specifications

Every production binary published under the Cluely Copilot release stream is deterministically built from source, packaged via `electron-builder`, and cryptographically signed using Microsoft Authenticode.

| Property | Value |
|---|---|
| **Binary File Name** | `Cluely-Copilot-1.0.1-Windows-x64.exe` |
| **Release Tag** | `v1.0.1` |
| **Target Architecture** | Windows x64 (AMD64 / Intel 64-bit) |
| **Packaging Framework** | `electron-builder` v25.1.8 (NSIS Installer) |
| **SHA-256 Checksum** | `157ef479e8481d4d29b04ba52b4e16695a53030fc647dcf5e25d1d1eff4e71f5` |
| **Checksum Manifest** | `Cluely-Copilot-1.0.1-Windows-x64.exe.sha256` |

---

## 2. Windows Authenticode Cryptographic Signature Details

The binary is signed with an embedded Microsoft Authenticode digital signature and counter-signed with a cryptographically verifiable RFC 3161 timestamp issued by DigiCert:

```text
[Authenticode Digital Signature]
  Signer Common Name (CN): Cluely Copilot Developer
  Signer Serial Number:    5C6955BC959B6DB2487BA4E1CB60C31E
  Signer Certificate SHA-1 Thumbprint: 6CC23332BC4A72004EF0AC553D0E1FD19D34E843
  Signature Digest Algorithm: SHA-256

[RFC 3161 Cryptographic Timestamp]
  TimeStamper Authority:   DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1
  Timestamp Responder:     CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1, O="DigiCert, Inc.", C=US
  Timestamp Serial Number: 084FDC334F7E454EDBC30F8FF9921835
  Timestamp Thumbprint:    51D9ABDA034973D84F4266ACA48248E6B369C439
  Timestamp Server:        http://timestamp.digicert.com
```

---

## 3. User Verification Commands (PowerShell)

Users and security auditors can verify the cryptographic integrity and Authenticode signature of the downloaded installer before running it:

### Step 1: Verify SHA-256 Checksum
Open PowerShell in the folder containing the downloaded installer:

```powershell
Get-FileHash .\Cluely-Copilot-1.0.1-Windows-x64.exe -Algorithm SHA256
```

**Expected Output**:
```text
Algorithm       Hash                                                             Path
---------       ----                                                             ----
SHA256          157EF479E8481D4D29B04BA52B4E16695A53030FC647DCF5E25D1D1EFF4E... Cluely-Copilot-1.0.1-Windows-x64.exe
```

Confirm that the hash matches:
```text
157ef479e8481d4d29b04ba52b4e16695a53030fc647dcf5e25d1d1eff4e71f5
```

---

### Step 2: Verify Embedded Authenticode Signature
Run the built-in Windows `Get-AuthenticodeSignature` cmdlet:

```powershell
Get-AuthenticodeSignature .\Cluely-Copilot-1.0.1-Windows-x64.exe | Format-List SignerCertificate, TimeStamperCertificate, Status, SignatureType
```

**Expected Output**:
```text
SignerCertificate      : [Subject] CN=Cluely Copilot Developer ...
                         [Thumbprint] 6CC23332BC4A72004EF0AC553D0E1FD19D34E843
TimeStamperCertificate : [Subject] CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1 ...
                         [Thumbprint] 51D9ABDA034973D84F4266ACA48248E6B369C439
SignatureType          : Authenticode
```

---

## 4. Understanding Windows SmartScreen & Smart App Control

### Why Does Windows Display "Smart App Control has not verified this app" or "Windows protected your PC"?
1. **Publisher Reputation in Windows**:
   * Microsoft SmartScreen and Windows 11 Smart App Control evaluate executables based on cloud-tracked **binary and certificate reputation**, rather than local malware heuristics.
   * Standard Code Signing certificates and initial developer releases have not yet accumulated hundreds of thousands of corporate downloads across Microsoft's global telemetry network.
2. **Authenticode Verification**:
   * Inspecting **File Properties → Digital Signatures** on `Cluely-Copilot-1.0.1-Windows-x64.exe` confirms that the binary is cryptographically intact and has not been altered or tampered with since compilation.
3. **Running the Verified Binary**:
   * In the SmartScreen prompt, click **"More info"**.
   * Verify that the publisher matches **"Cluely Copilot Developer"**.
   * Click **"Run anyway"**.
4. **Roadmap to Instant Zero-Prompt Trust**:
   * For enterprise and broad consumer distribution, the project roadmap includes provisioning an **Extended Validation (EV) Hardware Security Module (HSM)** token or enrolling in the **Microsoft Artifact Signing Service** (Public Trust Model), establishing immediate out-of-the-box SmartScreen reputation.

---

## 5. Clean-Room Build & Reproduction Procedure

To rebuild and package the verified Windows installer from source:

```powershell
# 1. Clone the repository and enter the application workspace
git clone https://github.com/MokuLakshithReddy/Cluely-AI-Desktop-Assistant.git
cd Cluely-AI-Desktop-Assistant/app

# 2. Clean install dependencies
npm ci

# 3. Execute full verification suite (89/89 tests must pass)
npm run test:report

# 4. Package Windows distribution
npm run dist:win
```

The resulting executable will be generated in `app/release/Cluely-Copilot-1.0.1-Windows-x64.exe`.

