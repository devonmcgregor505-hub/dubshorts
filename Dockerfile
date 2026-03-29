FROM node:22-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN cd caption-remover && npm install
EXPOSE 8080
CMD ["node", "index.js"]
