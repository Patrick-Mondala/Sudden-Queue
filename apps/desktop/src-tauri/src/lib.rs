#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single instance has to be registered before anything else, because it
    // decides whether this process is going to live at all. A second launch
    // hands its arguments to the first and exits; the first raises the window
    // it already has.
    //
    // Presence is per-account on the server, so two copies would not double
    // anyone's queue slot -- but they would fight over the same session, and a
    // scrim prompt raised in the window you are not looking at is worse than no
    // prompt.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
