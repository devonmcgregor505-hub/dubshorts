FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip fonts-dejavu \
    libgl1-mesa-glx libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir opencv-python-headless numpy Pillow openai-whisper simple-lama-inpainting --break-system-packages

# Pre-download Whisper base model so it is cached in the image
RUN python3 -c "import whisper; whisper.load_model(chr(98)+chr(97)+chr(115)+chr(101))"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080
CMD ["npm", "start"]
