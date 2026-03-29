FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
WORKDIR /app/caption-remover
RUN npm install
CMD ["node", "server.js"]
