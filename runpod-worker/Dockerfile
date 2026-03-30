FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg git wget unzip libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --upgrade pip
RUN pip install numpy==1.26.4
RUN pip install easyocr opencv-python-headless runpod requests scikit-image kornia easydict scikit-learn pandas joblib
RUN git clone https://github.com/advimman/lama.git /app/lama
RUN pip install omegaconf pytorch-lightning==1.9.5 webdataset tensorboard
RUN pip install albumentations packaging huggingface_hub
RUN mkdir -p /app/lama_weights && \
    wget -q https://huggingface.co/smartywu/big-lama/resolve/main/big-lama.zip -O /app/lama_weights/big-lama.zip && \
    unzip /app/lama_weights/big-lama.zip -d /app/lama_weights/ && \
    rm /app/lama_weights/big-lama.zip
COPY handler.py /app/handler.py
CMD ["python3", "-u", "/app/handler.py"]
