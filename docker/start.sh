#!/bin/sh

# 🚀 Starting Documenso...
printf "🚀 Starting Documenso...\n\n"

# 🔐 Check certificate configuration
printf "🔐 Checking certificate configuration...\n"

CERT_PATH="${NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH:-/opt/documenso/cert.p12}"

# The certificate arrives either as a file or, as it does on Fargate, as base64
# in the environment. Testing only the path made the first deployed task print
# "signing will be unavailable" while /api/health reported the certificate as
# ok, which is a banner that teaches whoever reads the logs to distrust them.
if [ -n "${NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS:-}" ] || { [ -f "$CERT_PATH" ] && [ -r "$CERT_PATH" ]; }; then
    printf "✅ Certificate available - document signing is ready!\n"
else
    printf "⚠️ Certificate not found or not readable\n"
    printf "💡 Tip: Documenso will still start, but document signing will be unavailable\n"
    printf "🔧 Check: http://localhost:3000/api/certificate-status for detailed status\n"
fi

printf "\n📚 Useful Links:\n"
printf "📖 Documentation: https://docs.documenso.com\n"
printf "🐳 Self-hosting guide: https://docs.documenso.com/developers/self-hosting\n"
printf "🔐 Certificate setup: https://docs.documenso.com/developers/self-hosting/signing-certificate\n"
printf "🏥 Health check: http://localhost:3000/api/health\n"
printf "📊 Certificate status: http://localhost:3000/api/certificate-status\n"
printf "👥 Community: https://github.com/documenso/documenso\n\n"

printf "🗄️  Running database migrations...\n"
npx prisma migrate deploy --schema ../../packages/prisma/schema.prisma

printf "🌟 Starting Documenso server...\n"
# exec, so node replaces this shell as PID 1 and receives the SIGTERM that ECS
# sends on a deploy. Without it the shell takes the signal, does not pass it on,
# and node is killed 30 seconds later with requests and jobs still running.
export HOSTNAME=0.0.0.0
exec node build/server/main.js
