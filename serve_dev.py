# Servidor local para probar Hub Recepción mientras se desarrolla.
# A diferencia de "python -m http.server", este SIEMPRE manda
# Cache-Control: no-store — así el navegador nunca se queda con una versión
# vieja de un archivo JS/CSS/JSON aunque ya se haya reemplazado en disco.
# (El servidor de producción, GitHub Pages, no necesita este script — ahí
# lo que evita quedarse con una versión vieja es la estrategia "red primero"
# de sw.js.)
#
# Uso:
#   python serve_dev.py [puerto]   (por defecto 8794)

import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8794
server = ThreadingHTTPServer(("0.0.0.0", port), NoCacheHandler)
print(f"Hub Recepción (modo desarrollo, sin cache) sirviendo en http://localhost:{port}")
server.serve_forever()
