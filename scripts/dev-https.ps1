param(
  [string]$Domain = "api.speakup.local",
  [string]$Port = "3000",
  [string]$CertDir = "./certs"
)

$ErrorActionPreference = "Stop"

if (-not $env:JWT_SECRET) {
  $env:JWT_SECRET = "replace-me"
}

$resolvedCertDir = Resolve-Path $CertDir -ErrorAction SilentlyContinue
if (-not $resolvedCertDir) {
  throw "Certificate directory not found: $CertDir"
}

$certPath = Join-Path $resolvedCertDir "$Domain+3.pem"
$keyPath = Join-Path $resolvedCertDir "$Domain+3-key.pem"

if (-not (Test-Path $certPath)) {
  throw "Certificate file not found: $certPath"
}

if (-not (Test-Path $keyPath)) {
  throw "Key file not found: $keyPath"
}

$env:PORT = $Port
$env:PUBLIC_HOSTNAME = $Domain
$env:SSL_CERT_FILE = $certPath
$env:SSL_KEY_FILE = $keyPath
$env:ALLOWED_ORIGINS = "https://localhost:8081,https://${Domain}:8081,exp://127.0.0.1:8081"

Write-Host "Starting HTTPS API at https://${Domain}:${Port}"
Write-Host "Using cert: $certPath"

npm run dev