"""Real Pi, fresh public private-question composition, synthetic TEST inputs/provider.
No historical/copied-candidate approval. F12 observes public focused render; overhead explicit.
"""
import os, sys, json, pathlib, time, pexpect
root, directory, pi = sys.argv[1:]
root, directory = pathlib.Path(root), pathlib.Path(directory)
directory.mkdir(parents=True, exist_ok=True)
log = directory / 'events.jsonl'
matrix = os.environ.get('OWNED_QUESTION_MATRIX') == '1'
env = dict(os.environ, HOME=str(directory / 'home'), PI_CODING_AGENT_DIR=str(directory / 'agent'),
           TERM='xterm-256color', PI_OFFLINE='1', OWNED_QUESTION_LOG=str(log), OWNED_QUESTION_RELEASE=str(directory / 'release'))
agent = directory / 'agent'; agent.mkdir()
node = os.environ['OWNED_QUESTION_NODE']
(agent / 'settings.json').write_text(json.dumps({'externalEditor': json.dumps(node) + ' ' + json.dumps(str(root / 'packages/pi-extension/fixtures/questions-test-editor.mjs'))}))
args = ['--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-builtin-tools',
        '-e', str(root / 'packages/pi-extension/fixtures/questions-pty-host.ts'), '--provider', 'owned-question-test', '--model', 'local', '--session-dir', str(directory / 'sessions')]
child = None

def events():
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

def wait(predicate, message, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate(): return
        try: child.read_nonblocking(65536, timeout=.05)
        except pexpect.TIMEOUT: pass
        except pexpect.EOF: raise AssertionError('Pi exited: ' + message)
    raise AssertionError(message)

def send(data):
    child.send(data)
    deadline = time.monotonic() + .15
    while time.monotonic() < deadline:
        try: child.read_nonblocking(65536, timeout=.03)
        except pexpect.TIMEOUT: pass

def observe():
    before = len(events()); send('\x1b[24~')
    wait(lambda: any(e['event'] == 'observation' for e in events()[before:]), 'fresh F12 observation missing')
    return next(e for e in reversed(events()) if e['event'] == 'observation')

def current(observation):
    return (observation.get('snapshot') or {}).get('current') or {}

def stop():
    if child and child.isalive():
        child.sendcontrol('c'); child.sendcontrol('c')
        try: child.expect(pexpect.EOF, timeout=5)
        except pexpect.TIMEOUT: child.terminate(force=True)

def start(extra, prefix):
    process = pexpect.spawn(pi, args + extra, cwd=str(root), env=env, encoding='utf-8', dimensions=(24, 80), timeout=15)
    process.logfile_read = open(directory / (prefix + '.receive.txt'), 'w')
    process.logfile_send = open(directory / (prefix + '.send.txt'), 'w')
    return process

try:
    child = start([], 'original')
    wait(lambda: any(e['event'] == 'ready' for e in events()), 'fresh fixture ready missing')
    send('TEST_START\r')
    wait(lambda: any(e['event'] == 'work_started' for e in events()), 'independent work never began')
    native = [e['result']['details'] for e in events() if e['event'] == 'tool_end' and e['id'] in ('NATIVE_A', 'NATIVE_C')]
    assert len(native) == 2 and all(result['status'] == 'pending' for result in native)
    a, c = native
    frame = observe(); assert current(frame)['tab']['questionId'] == a['id'] and frame['editorLike'], 'async arrival stole ordinary input focus'
    assert frame['editor'] == 'KEEP_ORDINARY_EDITOR'
    send('\x1b[Z'); frame = observe(); assert not frame['editorLike'], 'Shift+Tab did not enter the passive async pane'
    send('DRAFT_A'); frame = observe()
    assert all(value in '\n'.join(frame['lines']) for value in ['Quiet', 'Bright', 'DRAFT_A'])
    assert not any(e['event'] == 'work_finished' for e in events())
    send('\x1d'); send('+'); send('\x1d'); frame = observe()
    assert current(frame)['reply'] == 'DRAFT_A' and frame['editor'] == 'KEEP_ORDINARY_EDITOR+'
    send('\x07')
    wait(lambda: any(e['event'] == 'test_external_editor' for e in events()), 'our configured external editor never ran')
    assert next(e for e in events() if e['event'] == 'test_external_editor')['original'] == 'DRAFT_A'
    frame = observe(); assert current(frame)['reply'] == 'DRAFT_A\nEDITED '
    (directory / 'release').touch()
    wait(lambda: any(e['event'] == 'tool_start' and e['id'] == 'BLOCK_B' for e in events()), 'blocking producer never started')
    frame = observe(); assert current(frame)['tab']['questionId'] == 'question:0' and not frame['editorLike']
    assert 'Response required' in '\n'.join(frame['lines'])
    send('\x1d'); frame = observe(); assert current(frame)['tab']['questionId'] == 'question:0' and not frame['editorLike'], 'collapse escaped the blocker'
    send('\x1b[Z'); frame = observe(); assert current(frame)['tab']['questionId'] == 'question:0' and not frame['editorLike'], 'focus toggle escaped the blocker'
    if matrix:
        send('\x0c'); frame = observe()
        assert current(frame)['tab']['questionId'] == 'question:0' and not frame['editorLike'] and 'Response required' in '\n'.join(frame['lines']), 'global model shortcut escaped the blocker'
        pathlib.Path(str(directory / 'release') + '.foreign').touch(); observe()
        wait(lambda: any(e['event'] == 'foreign_started' for e in events()), 'SDK foreign selector did not start')
        frame = observe(); assert 'TEST foreign selector' in '\n'.join(frame['lines'])
        send('\x1b'); wait(lambda: any(e['event'] == 'foreign_ended' for e in events()), 'SDK foreign selector did not complete')
        frame = observe(); assert current(frame)['tab']['questionId'] == 'question:0' and not frame['editorLike']
        assert not any(e['event'] == 'tool_end' and e['id'] == 'BLOCK_B' for e in events()), 'foreign Cancel completed our blocker'
    assert [tab['mode'] for tab in frame['snapshot']['tabs']] == ['blocking'] * 3 + ['async'] * 2
    send('\t\t\t'); frame = observe(); assert current(frame)['tab']['questionId'] == a['id'] and current(frame)['reply'] == 'DRAFT_A\nEDITED '
    child.setwinsize(18, 80); frame = observe(); assert len(frame['lines']) <= 6
    child.setwinsize(24, 80); send('\r'); frame = observe()
    if matrix:
        wait(lambda: any(e['event'] == 'controlled_append_failure' for e in events()), 'actual preappend save failure never fired')
        frame = observe(); assert current(frame)['tab']['questionId'] == a['id'] and current(frame)['reply'] == 'DRAFT_A\nEDITED '
        assert current(frame)['error'] and 'Save failed' in '\n'.join(frame['lines']), 'save failure not immediately visible'
        assert not any(e.get('customType') == 'threadroom.native.answer.v1' for e in frame['branch']), 'failure fabricated saved answer'
        assert not any(e['event'] == 'provider_feedback' for e in events()), 'failure fabricated provider delivery'
        send('\r'); frame = observe()
    assert not any(e['event'] == 'tool_end' and e['id'] == 'BLOCK_B' for e in events()), 'async save completed blocker'
    assert not any(e['event'] == 'provider_feedback' for e in events()), 'missed held-blocker queue window'
    send('\t'); send('\x1b[32u'); send('\x1b[B'); send(' '); send('\x1bn'); send('OPEN_NOTE'); send('\t')
    frame = observe(); assert all(value in '\n'.join(frame['lines']) for value in ['OPEN_NOTE', 'Submit answers', 'Cancel'])
    send('\r'); wait(lambda: any(e['event'] == 'tool_end' and e['id'] == 'BLOCK_B' for e in events()), 'partial blocker did not complete')
    result = next(e['result'] for e in events() if e['event'] == 'tool_end' and e['id'] == 'BLOCK_B')
    assert len(result['details']['answers']) == 1
    answer = result['details']['answers'][0]; assert answer['questionIndex'] == 1 and answer['selected'] == ['North', 'South'] and answer['notes'] == 'OPEN_NOTE'
    frame = observe(); assert not frame['editorLike'] and current(frame)['tab']['questionId'] == c['id'], 'answering the required group returned to Chat before remaining async work'
    wait(lambda: any(e['event'] == 'tool_start' and e['id'] == 'PROMOTE_C' for e in events()), 'existing async question was not promoted by stable ID')
    frame = observe(); assert current(frame)['tab']['questionId'] == c['id'] and current(frame)['tab']['mode'] == 'blocking' and not frame['editorLike']
    assert 'Response required' in '\n'.join(frame['lines'])
    send('\x1b'); wait(lambda: any(e['event'] == 'tool_end' and e['id'] == 'PROMOTE_C' for e in events()), 'promoted wait did not release')
    promoted = next(e['result']['details'] for e in events() if e['event'] == 'tool_end' and e['id'] == 'PROMOTE_C')
    assert promoted['questionId'] == c['id'] and promoted['cancelled'] is True and 'receivedNativeAnswerIds' not in promoted
    frame = observe(); assert current(frame)['tab']['questionId'] == c['id'] and current(frame)['tab']['mode'] == 'async' and not frame['editorLike'], 'releasing pane-owned wait did not preserve its async question'
    wait(lambda: any(e['event'] == 'settled' for e in events()), 'actual provider did not settle')
    send('\x1b'); send('\x15/reload\r')
    old_nonce = frame['nonce']; wait(lambda: any(e['event'] == 'ready' and e['nonce'] != old_nonce for e in events()), 'real reload did not produce fresh activation')
    frame = observe(); assert frame['nonce'] != old_nonce and frame['editorLike'] and current(frame)['tab']['questionId'] == c['id']
    assert len([e for e in events() if e['event'] == 'test_setup']) == 1, 'reload used helper-prompt focus assistance'
    send('\x1b[Z'); frame = observe(); assert not frame['editorLike']
    send('temp'); send('\x7f' * 4); send('\x1b[B')
    child.setwinsize(18, 80); send('\x1b[6~'); found = False
    for _ in range(40):
        frame = observe(); assert len(frame['lines']) <= 6
        if 'PREVIEW_29' in '\n'.join(frame['lines']): found = True; break
        send('\x1b[6~')
    assert found, 'full selected original preview tail inaccessible'
    send('\r'); wait(lambda: len([e for e in events() if e['event'] == 'provider_feedback']) >= 2, 'actual provider never consumed C')
    stop()
    session = next((directory / 'sessions').glob('*.jsonl'))
    disk = [json.loads(line) for line in session.read_text().splitlines()]
    answers = [e['data'] for e in disk if e.get('customType') == 'threadroom.native.answer.v1']
    receipts = [e['details'] for e in disk if e['type'] == 'custom_message' and e.get('customType') == 'threadroom.native.feedback.v1']
    assert len(answers) == len(receipts) == 2
    saved_a = next(e for e in answers if e['questionId'] == a['id']); saved_c = next(e for e in answers if e['questionId'] == c['id'])
    assert saved_a['answer']['text'] == 'DRAFT_A\nEDITED ' and saved_a['prompt']['question'] == 'TEST_ASYNC_A question?'
    assert saved_c['answer']['optionIndex'] == 1 and saved_c['answer']['selection']['preview'].endswith('PREVIEW_29')
    for saved in answers:
        assert sum(e['answerId'] == saved['answerId'] for e in receipts) == 1
        assert any(saved['answerId'] in json.dumps(e['feedback']) for e in events() if e['event'] == 'provider_feedback')
    proof = dict(syntheticNotScott=True, humanAcceptance=False, activated=False, freshOwnedImplementation=True, physicalPty=True,
                 privateDiskOriginalAssociations=True, actualProviderExactAnswerIds=True, matchingDiskReceiptsAfterExit=True,
                 asyncArrivalPassive=True, blockingSurfaceModal=True, jointBlockingPriorityAndIndependentSave=True, bothDraftsCollapseExternalEditor=True, reviewPartialChecksOpenNotes=True,
                 hotReloadNoHelperPrompt=True, fullNativePreview80x18=True, coldResumeNotClaimed=True, promotedStableIdCancelPreservesAsync=True,
                 builtinModelShortcutBlocked=matrix, foreignSelectorIsolation=matrix, actualPreappendFailureDraftRetry=matrix,
                 observationQualification='Initial public custom setup once per process; F12 samples public focused render which may reconcile. IO/render overhead explicit.')
    (directory / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n'); print(json.dumps(proof))
finally:
    stop()
