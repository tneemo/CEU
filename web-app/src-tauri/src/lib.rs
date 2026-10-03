use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

const PORT: u16 = 4747;

/// The Python server we spawned, if any. `None` when another instance was
/// already listening on the port (e.g. started by hand) — we reuse it and
/// leave it running on exit.
struct ServerProcess(Mutex<Option<Child>>);

fn repo_root() -> PathBuf {
  // CEU_ROOT overrides; otherwise src-tauri/ -> web-app/ -> repo root
  // (where server/ and .venv/ live), resolved at compile time.
  if let Ok(root) = std::env::var("CEU_ROOT") {
    return PathBuf::from(root);
  }
  std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("..")
    .join("..")
    .canonicalize()
    .expect("could not resolve repo root")
}

fn server_running() -> bool {
  let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
  TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn spawn_server() -> std::io::Result<Child> {
  let root = repo_root();
  let python = root.join(".venv").join("Scripts").join("python.exe");
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

      if server_running() {
        log::info!("CEU server already listening on :{PORT}; reusing it");
      } else {
        match spawn_server() {
          Ok(child) => {
            log::info!("CEU server started (pid {})", child.id());
            *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
          }
          Err(e) => log::error!("Failed to start CEU server: {e}"),
        }
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
