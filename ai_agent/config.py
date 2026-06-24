import os

# Environment configs
SERVICE_PORT = int(os.getenv("SERVICE_PORT", 5000))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
