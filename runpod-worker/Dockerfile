FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg git wget && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/sczhou/ProPainter.git /app/ProPainter
RUN pip install -r /app/ProPainter/requirements.txt
RUN pip install runpod requests opencv-python-headless numpy imageio imageio-ffmpeg
COPY handler.py /app/handler.py
CMD ["python3", "-u", "/app/handler.py"]
