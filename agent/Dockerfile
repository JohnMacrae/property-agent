FROM node:20-slim

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# UID 1002 matches host user john for mounted volume permissions
RUN useradd -m -u 1002 -s /bin/bash agent

WORKDIR /agent
COPY package*.json ./
RUN npm install --omit=dev

COPY scheduler.js ./
COPY agent-runner.js ./
COPY store.js ./
COPY db.js ./
COPY telegram.js ./
COPY freeagent.js ./
COPY maintenance.js ./
COPY docs.js ./
COPY gcal.js ./
COPY pending.js ./
COPY wo.js ./
COPY wo-colour.js ./
COPY wo-report.js ./
COPY invoice-run.js ./
COPY gmail.js ./
COPY wo-scan-noise.js ./
COPY wo-gmail-scan.js ./
COPY keys.js ./

RUN chown -R agent:agent /agent

USER agent

CMD ["node", "scheduler.js"]
