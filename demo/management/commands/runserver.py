"""
Custom runserver that skips the reverse-DNS lookup Django performs on the bind
address at startup.  socket.getfqdn() can block for 30+ seconds on systems
where reverse DNS for 127.0.0.1 times out before falling back to /etc/hosts.

Django already short-circuits getfqdn() for incoming requests
(WSGIRequestHandler.address_string), but not for WSGIServer.server_bind().
"""

import socketserver

from django.core.management.commands.runserver import Command as BaseCommand
from django.core.servers.basehttp import WSGIServer


class _NoFqdnWSGIServer(WSGIServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host  # raw address; skip socket.getfqdn()
        self.server_port = port
        self.setup_environ()


class Command(BaseCommand):
    server_cls = _NoFqdnWSGIServer
