FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-dev \
    fonts-dejavu \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip3 install simple-lama-inpainting opencv-python-headless numpy Pillow --break-system-packages

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

EXPOSE 8080
CMD ["npm", "start"]
