"""Hold an OS lock before startup recovery can change the database."""
from contextlib import contextmanager
import os


@contextmanager
def lock(data_dir):
    os.makedirs(data_dir, exist_ok=True)
    # Keep the file: unlinking a locked file would permit a second lock on Unix.
    with open(os.path.join(data_dir, ".server.lock"), "a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if not handle.tell():
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("Já existe um servidor CEU usando esta pasta de dados.") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)
