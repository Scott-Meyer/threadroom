"""Real Pi 0.85.1 PTY interaction; deterministic provider, real UI/session/delivery."""
import json, os, pathlib, sys, time, pexpect

root, directory, pi = sys.argv[1:]
dir = pathlib.Path(directory)
log = dir / 'events.jsonl'
release = dir / 'release'
env = dict(os.environ, PI_CODING_AGENT_DIR=str(dir / 'agent'), NATIVE_TEST_LOG=str(log),
           NATIVE_TEST_RELEASE=str(release), THREADROOM_API_URL='http://127.0.0.1:1', TERM='xterm-256color', PI_OFFLINE='1')
base = ['--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '-e',
        str(pathlib.Path(root) / 'packages/pi-extension/fixtures/native-host.ts'),
        '--provider', 'native-test', '--model', 'local', '--session-dir', str(dir / 'sessions'), '--no-builtin-tools']


def events():
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


def wait(predicate, message):
    end = time.time() + 12
    while time.time() < end:
        if predicate(): return
        try: child.read_nonblocking(65536, timeout=0.05)
        except pexpect.TIMEOUT: pass
        except pexpect.EOF: raise AssertionError('Pi exited: ' + message)
        time.sleep(0.05)
    raise AssertionError(message + '\n' + json.dumps(events(), indent=2)[-12000:])


def send(value):
    child.send(value)
    end = time.time() + 0.4
    while time.time() < end:
        try: child.read_nonblocking(65536, timeout=0.05)
        except pexpect.TIMEOUT: pass


def probe():
    count = sum(e['event'] == 'probe' for e in events())
    send('/native-probe\r')
    wait(lambda: sum(e['event'] == 'probe' for e in events()) > count, 'probe did not run')
    return [e for e in events() if e['event'] == 'probe'][-1]


def start(extra=[]):
    ready = sum(e['event'] == 'ready' for e in events())
    c = pexpect.spawn(pi, base + extra, cwd=root, env=env, encoding='utf-8', dimensions=(40, 110), timeout=12)
    c.logfile = open(dir / ('terminal-resume.txt' if extra else 'terminal.txt'), 'w')
    end = time.time() + 15
    while sum(e['event'] == 'ready' for e in events()) <= ready:
        assert time.time() < end, 'Pi startup never reached session_start'
        try: c.read_nonblocking(65536, timeout=0.1)
        except pexpect.TIMEOUT: pass
    time.sleep(0.3)
    return c


def stop():
    child.sendcontrol('c'); time.sleep(0.2); child.sendcontrol('c')
    try: child.expect(pexpect.EOF, timeout=4)
    except pexpect.TIMEOUT: child.terminate(force=True)


child = start()
try:
    send('ask-native\r')
    send('FOCUS_DRAFT')
    wait(lambda: any(e['event'] == 'work_started' for e in events()), 'independent work never started')
    ask_end = next(e for e in events() if e['event'] == 'tool_end' and e['name'] == 'ask_user_question_async')
    assert ask_end['result']['details']['status'] == 'pending', ask_end
    assert ask_end['editor'] == 'FOCUS_DRAFT', ask_end
    assert not any(e['event'] == 'ui_prompt_start' for e in events()), 'creation took input focus'
    # /asks is intentionally opened while independent work is still running.
    send('\x15/asks\r')
    wait(lambda: any(e['event'] == 'ui_prompt_start' for e in events()), '/asks did not open native UI')
    send('\r')  # select inbox item
    send('DISCARDED_DRAFT')
    send('\x1b')
    wait(lambda: any(e['event'] == 'ui_prompt_end' for e in events()), 'Escape did not close UI')
    send('/asks\r')
    wait(lambda: sum(e['event'] == 'ui_prompt_start' for e in events()) == 2, 'dismissed question could not reopen')
    send('\r')
    send('Refine the tail freely\r')
    # Save happened while original tool is still running; queued steer isn't yet a receipt.
    send('/native-probe\r')
    wait(lambda: any(e['event'] == 'probe' for e in events()), 'probe during work did not run')
    branch = [e for e in events() if e['event'] == 'probe'][-1]['branch']
    saved = [e for e in branch if e['type'] == 'custom' and e.get('customType') == 'threadroom.native.answer.v1']
    assert len(saved) == 1, branch
    answer = saved[0]['data']
    assert answer['answer']['text'] == 'Refine the tail freely', answer
    assert answer['prompt']['question'] == 'Which detail should I refine?', answer
    assert not any(e['type'] == 'custom_message' and e.get('customType') == 'threadroom.native.feedback.v1' for e in branch), 'void send was treated as receipt'
    assert not any(e['event'] == 'work_finished' for e in events()), 'test missed streaming answer window'
    if env.get('NATIVE_TEST_RELOAD_INTERRUPTION') == '1':
        # UI /reload is idle-only, and UI Escape clears its steering queue.
        # Saved feedback survives that interruption; reload must not guess/resend.
        send('\x1b'); release.touch()
        wait(lambda: any(e['event'] == 'settled' for e in events()), 'aborted agent did not settle')
        branch = probe()['branch']
        assert not any(e['type'] == 'custom_message' and e.get('customType') == 'threadroom.native.feedback.v1' for e in branch), 'test missed queued abort window'
        ready_before_reload = sum(e['event'] == 'ready' for e in events())
        send('/reload\r')
        wait(lambda: sum(e['event'] == 'ready' for e in events()) > ready_before_reload, 'reload did not finish with queued feedback')
        branch = probe()['branch']
        assert not any(e['type'] == 'custom_message' and e.get('customType') == 'threadroom.native.feedback.v1' for e in branch), 'reload resubmitted queued feedback'
        # Physical quit/resume is the explicit recovery path for uncertain queues.
        stop()
        original_file = next((dir / 'sessions').glob('*.jsonl'))
        child = start(['--session', str(original_file)])
        wait(lambda: any(e['event'] == 'feedback_seen' for e in events()), 'saved feedback did not recover on original-process restart')
    else:
        release.touch()
        wait(lambda: any(e['event'] == 'feedback_seen' for e in events()), 'saved feedback did not steer at legal boundary')
    wait(lambda: any(e['event'] == 'settled' for e in events()), 'agent did not settle')
    before = sum(e['event'] == 'probe' for e in events())
    send('/native-probe\r')
    wait(lambda: sum(e['event'] == 'probe' for e in events()) > before, 'settled probe did not run')
    branch = [e for e in events() if e['event'] == 'probe'][-1]['branch']
    receipt = [e for e in branch if e['type'] == 'custom_message' and e.get('customType') == 'threadroom.native.feedback.v1']
    assert len(receipt) == 1 and receipt[0]['details']['answerId'] == answer['answerId'], receipt
    prior = sum(e['event'] == 'feedback_seen' for e in events())
    send('/native-seed-idle\r')
    wait(lambda: any(e['event'] == 'idle_seed' for e in events()), 'idle follow-up creation failed')
    send('/asks\r'); send('\r'); send('\t'); send('\r')
    wait(lambda: sum(e['event'] == 'feedback_seen' for e in events()) > prior, 'idle saved answer did not wake AI')
    send('/native-probe\r')
    branch = [e for e in events() if e['event'] == 'probe'][-1]['branch']
    idle_answers = [e['data'] for e in branch if e.get('customType') == 'threadroom.native.answer.v1' and e['data']['questionId'] != answer['questionId']]
    assert len(idle_answers) == 1 and idle_answers[0]['answer']['selection']['preview'] == 'A soft finish.', idle_answers
    prior = sum(e['event'] == 'feedback_seen' for e in events())
    send('/native-tree-recover\r')
    wait(lambda: any(e['event'] == 'tree_finished' for e in events()), 'real tree navigation did not settle')
    assert next(e for e in events() if e['event'] == 'tree_emitted')['idle'] is False, 'test missed actual controller-finally timing'
    wait(lambda: sum(e['event'] == 'feedback_seen' for e in events()) > prior, 'saved feedback was stranded after real tree settlement')
    assert not any(e['event'] == 'fetch' for e in events()), 'native ask called HTTP'
finally:
    stop()

# Reopen actual persisted original session: question/answer/receipt survive, no wake replay.
session = next((dir / 'sessions').glob('*.jsonl'))
prior_feedback = sum(e['event'] == 'feedback_seen' for e in events())
child = start(['--session', str(session)])
try:
    count = sum(e['event'] == 'probe' for e in events())
    send('/native-probe\r')
    wait(lambda: sum(e['event'] == 'probe' for e in events()) > count, 'resume probe did not run')
    branch = [e for e in events() if e['event'] == 'probe'][-1]['branch']
    assert any(e.get('customType') == 'threadroom.native.answer.v1' and e['data']['answerId'] == answer['answerId'] for e in branch)
    assert sum(e['event'] == 'feedback_seen' for e in events()) == prior_feedback, 'saved receipt replayed wake after resume'
finally:
    stop()
print('Native TUI: immediate return, unchanged editor, voluntary open, Escape/reopen, saved-before-steer, idle wake, real receipt and resume verified.')
