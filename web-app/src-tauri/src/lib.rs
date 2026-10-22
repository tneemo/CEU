use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

const PORT: u16 = 4747;

/// The Python server we spawned, if any. `None` when another instance was
/// already listening on the port (e.g. started by hand) — we reuse it and
/// leave it running on exit.
struct ServerProcess(Mutex<Option<Child>>);

fn repo_root() -> io::Result<PathBuf> {
  let root = std::env::var_os("CEU_ROOT").filter(|value| !value.is_empty()).map(PathBuf::from);
  #[cfg(debug_assertions)]
  let root = root.or_else(|| Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")));
  // Release builds never use the build machine's checkout path.
  let root = root.or_else(|| std::env::current_dir().ok());
  match root {
    Some(path) if path.join("server/main.py").is_file() => path.canonicalize(),
    _ => Err(io::Error::new(io::ErrorKind::NotFound,
      "CEU requer o backend Python. Execute-o primeiro ou defina CEU_ROOT para a pasta do código-fonte com .venv instalada.")),
  }
}

fn server_running() -> io::Result<bool> {
  let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
  let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
    return Ok(false);
  };
  stream.set_read_timeout(Some(Duration::from_secs(1)))?;
  stream.set_write_timeout(Some(Duration::from_secs(1)))?;
  stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:4747\r\nConnection: close\r\n\r\n")?;
  let mut response = String::new();
  if let Err(error) = stream.take(4096).read_to_string(&mut response) {
    // Our child may have bound the port but still be initializing providers.
    if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) {
      return Ok(false);
    }
    return Err(error);
  }
  if response.starts_with("HTTP/1.1 200 ") && response.contains("\"app\": \"CEU\"") {
    Ok(true)
  } else {
    Err(io::Error::new(io::ErrorKind::AddrInUse, "A porta 4747 está ocupada por outro serviço."))
  }
}

fn spawn_server() -> std::io::Result<Child> {
  let root = repo_root()?;
  let python = root.join(".venv").join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
  let mut cmd = Command::new(python);
  cmd.args(["-m", "server.main", "--port", &PORT.to_string()]).current_dir(&root);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
  cmd.spawn()
}

/// The venv's python.exe is a launcher that starts the real interpreter as a
/// child process, so killing only the launcher would leave the server (and
/// the port) alive. Kill the whole tree.
fn kill_tree(child: &mut Child) {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
      .args(["/PID", &child.id().to_string(), "/T", "/F"])
      .creation_flags(CREATE_NO_WINDOW)
      .status();
  }
  let _ = child.kill();
  let _ = child.wait();
}

fn stop_server(app: &tauri::AppHandle) {
  let state = app.state::<ServerProcess>();
  let taken = state.0.lock().unwrap().take();
  if let Some(mut child) = taken {
    log::info!("Stopping CEU server (pid {})", child.id());
    kill_tree(&mut child);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .manage(ServerProcess(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      if server_running()? {
        log::info!("CEU server already listening on :{PORT}; reusing it");
      } else {
        let mut child = spawn_server()?;
        let ready = (|| -> io::Result<()> {
          let started = Instant::now();
          while started.elapsed() < Duration::from_secs(30) {
            if let Some(status) = child.try_wait()? {
              return Err(io::Error::other(format!("O backend CEU encerrou ({status}). Execute python -m server.main para ver o diagnóstico.")));
            }
            if server_running()? { return Ok(()); }
            std::thread::sleep(Duration::from_millis(100));
          }
          Err(io::Error::new(io::ErrorKind::TimedOut, "O backend CEU não ficou pronto em 30 segundos."))
        })();
        if let Err(error) = ready {
          kill_tree(&mut child);
          return Err(error.into());
        }
        log::info!("CEU server started (pid {})", child.id());
        *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        stop_server(app);
      }
    });
}
