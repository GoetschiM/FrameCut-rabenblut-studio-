"""Run the explicitly requested maintenance batch with the service's environment.

Invoked by a transient systemd unit as the framecut user. Never prints secrets,
copies tokens to disk, or restarts the web service. The Node command also checks
the confirmation, creates a database backup, and refuses an active old queue.
"""
import os
import shlex
import subprocess
from pathlib import Path

if os.environ.get('FRAMECUT_REBUILD_CONFIRM') != 'REBUILD_ALL_EXISTING':
    raise SystemExit('Explicit FRAMECUT_REBUILD_CONFIRM is required')
owner = os.environ.get('FRAMECUT_REBUILD_USER_ID', '')
if not owner.isdigit():
    raise SystemExit('Explicit FRAMECUT_REBUILD_USER_ID is required')
service_env = subprocess.check_output(
    ['systemctl', 'show', 'framecut.service', '--property=Environment', '--value'],
    text=True,
)
env = dict(os.environ)
for assignment in shlex.split(service_env):
    key, sep, value = assignment.partition('=')
    if sep:
        env[key] = value
env['FRAMECUT_REBUILD_CONFIRM'] = 'REBUILD_ALL_EXISTING'
env['FRAMECUT_REBUILD_USER_ID'] = owner
app = Path(__file__).resolve().parent.parent
os.chdir(app)
os.execve('/usr/local/bin/node', ['node', str(app / 'server.mjs'), '--rebuild-all-existing'], env)
