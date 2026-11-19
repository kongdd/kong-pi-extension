use std::{env, error::Error, fs::File, path::Path, process::ExitCode};

use rodio::{Decoder, DeviceSinkBuilder, Player};

const USAGE: &str = "Usage: audio-play <file.mp3>";

fn play(path: &Path) -> Result<(), Box<dyn Error>> {
    let source = Decoder::try_from(File::open(path)?)?;
    let mut output = DeviceSinkBuilder::open_default_sink()?;
    output.log_on_drop(false);

    let player = Player::connect_new(output.mixer());
    player.append(source);
    player.sleep_until_end();
    Ok(())
}

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let Some(arg) = args.next().filter(|_| args.next().is_none()) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };

    if arg == "--help" || arg == "-h" {
        println!("{USAGE}");
    } else if arg == "--version" || arg == "-V" {
        println!("audio-play {}", env!("CARGO_PKG_VERSION"));
    } else if let Err(err) = play(Path::new(&arg)) {
        eprintln!("audio-play: {}: {err}", Path::new(&arg).display());
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}
