import asyncio
import os
import sys
import uvicorn

# Suppress harmless Windows Proactor socket disconnection traces
if sys.platform == "win32":
    class QuietProactorEventLoopPolicy(asyncio.WindowsProactorEventLoopPolicy):
        def _loop_factory(self):
            loop = super()._loop_factory()
            original_exception_handler = loop.get_exception_handler()
            def custom_exception_handler(loop, context):
                exception = context.get("exception")
                if isinstance(exception, ConnectionResetError):
                    return  # Ignore client disconnects/refreshes
                if original_exception_handler:
                    original_exception_handler(loop, context)
                else:
                    loop.default_exception_handler(context)
            loop.set_exception_handler(custom_exception_handler)
            return loop

    asyncio.set_event_loop_policy(QuietProactorEventLoopPolicy())

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CERT_FILE = os.path.join(BASE_DIR, "certs", "queuesense-cert.pem")
KEY_FILE = os.path.join(BASE_DIR, "certs", "queuesense-key.pem")

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8443,
        reload=False,
        ssl_certfile=CERT_FILE,
        ssl_keyfile=KEY_FILE,
    )