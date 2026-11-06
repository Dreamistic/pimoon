//! Persistent, dependency-free CodeAct router. JSON payloads are opaque: no reparse/re-encode.
//! One binary frame = magic, opcode, session id, request id, bounded payload length.
use std::collections::HashMap;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::Instant;

const MAX_FRAME: usize = 8 * 1024 * 1024;
const INIT: u8 = 1;
const EXEC: u8 = 2;
const REPLY: u8 = 3;
const CANCEL: u8 = 4;
const CLOSE: u8 = 5;
const PING: u8 = 6;
const READY: u8 = 101;
const DONE: u8 = 102;
const CALL: u8 = 103;
const PONG: u8 = 108;
const ERROR: u8 = 109;
const METRICS: u8 = 110;

#[derive(Clone)]
struct Frame { op: u8, session: u32, request: u32, data: Vec<u8> }
impl Frame {
    fn read(reader: &mut impl Read) -> io::Result<Option<Self>> {
        let mut header = [0u8; 17];
        match reader.read(&mut header[..1])? { 0 => return Ok(None), _ => reader.read_exact(&mut header[1..])? }
        if &header[..4] != b"CA02" { return Err(io::Error::new(io::ErrorKind::InvalidData, "bad protocol magic")); }
        let number = |i| u32::from_le_bytes(header[i..i + 4].try_into().unwrap());
        let len = number(13) as usize;
        if len > MAX_FRAME { return Err(io::Error::new(io::ErrorKind::InvalidData, "frame exceeds 8 MiB")); }
        let mut data = vec![0; len]; reader.read_exact(&mut data)?;
        Ok(Some(Self { op: header[4], session: number(5), request: number(9), data }))
    }
    fn write(&self, writer: &mut impl Write) -> io::Result<()> {
        if self.data.len() > MAX_FRAME { return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large")); }
        let mut header = [0u8; 17]; header[..4].copy_from_slice(b"CA02"); header[4] = self.op;
        header[5..9].copy_from_slice(&self.session.to_le_bytes());
        header[9..13].copy_from_slice(&self.request.to_le_bytes());
        header[13..17].copy_from_slice(&(self.data.len() as u32).to_le_bytes());
        writer.write_all(&header)?; writer.write_all(&self.data)?; writer.flush()
    }
    fn response(&self, op: u8, data: impl Into<Vec<u8>>) -> Self {
        Self { op, session: self.session, request: self.request, data: data.into() }
    }
}
enum Event { Parent(Frame), Worker(u32, u64, Frame), WorkerExit(u32, u64), ParentExit }
struct Session {
    child: Child, input: BufWriter<ChildStdin>, generation: u64,
    active: Option<u32>, frames: u64, service_us: u128,
}
impl Drop for Session { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

fn spawn_session(frame: &Frame, root: &Path, worker: &Path, python: &str, generation: u64, tx: Sender<Event>) -> io::Result<Session> {
    let mut child = Command::new(python).args(["-X", "utf8", "-B"]).arg(worker)
        .current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
    let stdout = child.stdout.take().unwrap();
    let input = BufWriter::new(child.stdin.take().unwrap());
    let session = frame.session;
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(frame)) = Frame::read(&mut reader) {
            if tx.send(Event::Worker(session, generation, frame)).is_err() { return; }
        }
        let _ = tx.send(Event::WorkerExit(session, generation));
    });
    let mut entry = Session { child, input, generation, active: None, frames: 0, service_us: 0 };
    frame.write(&mut entry.input)?;
    Ok(entry)
}

fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--version") { println!("codeact-router 0.2.0 protocol CA02"); return Ok(()); }
    if args.len() != 4 { return Err(io::Error::other("usage: codeact-router ROOT WORKER PYTHON")); }
    let root = PathBuf::from(&args[1]).canonicalize()?;
    let worker = PathBuf::from(&args[2]).canonicalize()?;
    let (tx, rx) = mpsc::channel(); let parent_tx = tx.clone();
    thread::spawn(move || {
        let mut input = BufReader::new(io::stdin());
        while let Ok(Some(frame)) = Frame::read(&mut input) {
            if parent_tx.send(Event::Parent(frame)).is_err() { return; }
        }
        let _ = parent_tx.send(Event::ParentExit);
    });
    let mut output = BufWriter::new(io::stdout());
    let mut sessions: HashMap<u32, Session> = HashMap::new(); let mut generation = 0;
    while let Ok(event) = rx.recv() {
        let start = Instant::now();
        match event {
            Event::ParentExit => break,
            Event::Parent(frame) => {
                match frame.op {
                    PING => { frame.response(PONG, frame.data.clone()).write(&mut output)?; }
                    INIT => {
                        if sessions.contains_key(&frame.session) || sessions.len() >= 4 {
                            frame.response(ERROR, b"session exists or four-session limit reached".to_vec()).write(&mut output)?;
                        } else {
                            generation += 1;
                            match spawn_session(&frame, &root, &worker, &args[3], generation, tx.clone()) {
                                Ok(session) => { sessions.insert(frame.session, session); }
                                Err(error) => frame.response(ERROR, error.to_string().into_bytes()).write(&mut output)?,
                            }
                        }
                    }
                    CANCEL => {
                        sessions.remove(&frame.session);
                        frame.response(ERROR, b"cancelled; Python state lost; completed writes NOT rolled back".to_vec()).write(&mut output)?;
                    }
                    CLOSE => {
                        if frame.session == 0 { break; }
                        sessions.remove(&frame.session);
                        frame.response(READY, b"{}".to_vec()).write(&mut output)?;
                    }
                    EXEC | REPLY => {
                        if let Some(session) = sessions.get_mut(&frame.session) {
                            if frame.op == EXEC && session.active.is_some() {
                                frame.response(ERROR, b"session busy".to_vec()).write(&mut output)?; continue;
                            }
                            if frame.op == EXEC {
                                session.active = Some(frame.request); session.frames = 0; session.service_us = 0;
                            } else if session.active != Some(frame.request) {
                                frame.response(ERROR, b"stale tool reply".to_vec()).write(&mut output)?; continue;
                            }
                            frame.write(&mut session.input)?;
                            session.frames += 1; session.service_us += start.elapsed().as_micros();
                        } else { frame.response(ERROR, b"unknown session".to_vec()).write(&mut output)?; }
                    }
                    _ => { frame.response(ERROR, b"unknown opcode".to_vec()).write(&mut output)?; }
                }
            }
            Event::Worker(id, gen, mut frame) => {
                let Some(session) = sessions.get_mut(&id) else { continue };
                if session.generation != gen { continue; }
                frame.session = id;
                if frame.op != READY && session.active != Some(frame.request) { continue; }
                session.frames += 1;
                match frame.op {
                    DONE => {
                        session.service_us += start.elapsed().as_micros();
                        let stats = format!("{{\"frames\":{},\"broker_service_us\":{}}}",
                            session.frames, session.service_us);
                        frame.response(METRICS, stats.into_bytes()).write(&mut output)?;
                        frame.write(&mut output)?; session.active = None;
                    }
                    READY | CALL => { frame.write(&mut output)?; session.service_us += start.elapsed().as_micros(); }
                    _ => { frame.response(ERROR, b"invalid worker opcode".to_vec()).write(&mut output)?; }
                }
            }
            Event::WorkerExit(id, gen) => {
                if sessions.get(&id).is_some_and(|s| s.generation == gen) {
                    let session = sessions.remove(&id).unwrap();
                    if let Some(request) = session.active {
                        Frame { op: ERROR, session: id, request, data: b"Python worker exited; state lost".to_vec() }.write(&mut output)?;
                    }
                }
            }
        }
    }
    // Dropping sessions terminates all owned Python children on parent EOF or graceful close.
    drop(sessions);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_roundtrip_and_bound() {
        let frame = Frame { op: EXEC, session: 2, request: 9, data: "print('中文')".as_bytes().to_vec() };
        let mut bytes = Vec::new(); frame.write(&mut bytes).unwrap();
        let recovered = Frame::read(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(recovered.data, frame.data); assert_eq!(recovered.session, 2);
        let mut bad = bytes.clone(); bad[0] = 0; assert!(Frame::read(&mut bad.as_slice()).is_err());
        let mut bad = bytes; bad[13..17].copy_from_slice(&((MAX_FRAME + 1) as u32).to_le_bytes());
        assert!(Frame::read(&mut bad.as_slice()).is_err());
    }
}
