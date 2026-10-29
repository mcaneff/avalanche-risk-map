"""Serve this folder locally, the way GitHub Pages will.

     python3 serve.py            then open http://localhost:8000

Python's own `python3 -m http.server` ignores "Range" requests (asking for part of a file). The slope-scale maps
are read that way, a few kilobytes of a GeoTIFF at a time, so this small server adds Range support.
"""

import os
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", 8000))
RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


class RangeHandler(SimpleHTTPRequestHandler):
     def send_head(self):
          match = RANGE.match(self.headers.get("Range", ""))
          path = self.translate_path(self.path)
          if not match or not os.path.isfile(path):
               return super().send_head()                          # no Range asked: the normal whole file

          size = os.path.getsize(path)
          start, end = match.groups()
          if start == "":                                          # "bytes=-500": the last 500 bytes
               start, end = max(0, size - int(end)), size - 1
          else:
               start, end = int(start), min(int(end) if end else size - 1, size - 1)
          if start >= size:
               self.send_error(416, "Requested range not satisfiable")
               return None

          file = open(path, "rb")
          file.seek(start)
          self.send_response(206)
          self.send_header("Content-Type", self.guess_type(path))
          self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
          self.send_header("Content-Length", str(end - start + 1))
          self.send_header("Accept-Ranges", "bytes")
          self.end_headers()
          self._remaining = end - start + 1
          return file

     def copyfile(self, source, outputfile):
          remaining = getattr(self, "_remaining", None)
          if remaining is None:
               return super().copyfile(source, outputfile)
          while remaining > 0:                                     # send only the asked-for bytes
               chunk = source.read(min(64 * 1024, remaining))
               if not chunk:
                    break
               outputfile.write(chunk)
               remaining -= len(chunk)
          self._remaining = None


if __name__ == "__main__":
     here = os.path.dirname(os.path.abspath(__file__))
     print(f"serving {here} at http://localhost:{PORT}   (Ctrl-C to stop)")
     ThreadingHTTPServer(("", PORT), partial(RangeHandler, directory=here)).serve_forever()
