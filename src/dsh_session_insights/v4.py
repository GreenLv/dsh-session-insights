"""Bounded V4 admission for the read-only CLI (not an upstream migrator)."""
IDENTITY = {"target_dsh_version": "0.1.7-rc.2", "input_format_version": 4, "analyzer_semantics": "v4-rc2.2"}
SURFACE = {"user/message", "assistant/message", "system/message", "developer/message", "tool/result"}

def validate_records(records, known, *, physical=False):
    if not records or not isinstance(records[0], dict) or records[0].get("type") != "session" or records[0].get("version") != 4:
        raise ValueError("V4 header required; migrate old logs with upstream DSH tools")
    surface, markers = [], []
    for seq, event in enumerate(records[1:]):
        if not isinstance(event, dict) or event.get("seq") != seq or not isinstance(event.get("data"), dict):
            raise ValueError("invalid V4 sequence or event data")
        kind, data = event.get("type"), event["data"]
        if kind not in known:
            if event.get("ignorable") is not True:
                raise ValueError("unknown required V4 event")
            continue
        if kind == "session/end-seed" and data.get("inherited") is True:
            markers.append(seq)
        if "sourceEventSeqs" in event:
            sources = event["sourceEventSeqs"]
            if not isinstance(sources, list) or not sources:
                raise ValueError("invalid sourceEventSeqs")
            decoded, ranged = [], False
            for item in sources:
                if physical and isinstance(item, list):
                    ranged = True
                    if len(item) != 2 or any(type(n) is not int for n in item) or not 0 <= item[0] <= item[1] < seq:
                        raise ValueError("invalid sourceEventSeqs range")
                    decoded.extend(range(item[0], item[1]+1))
                elif type(item) is int and 0 <= item < seq:
                    decoded.append(item)
                else:
                    raise ValueError("invalid sourceEventSeqs reference")
            if len(set(decoded)) != len(decoded) or (ranged and decoded != sorted(decoded)):
                raise ValueError("duplicate or unordered sourceEventSeqs")
            event["sourceEventSeqs"] = decoded
        if kind not in SURFACE:
            continue
        message = data if kind == "user/message" else data.get("message")
        role = "tool" if kind == "tool/result" else kind.split("/")[0]
        if not isinstance(message, dict) or message.get("role") != role or not isinstance(message.get("id"), str) or not message["id"] or not isinstance(message.get("content"), list):
            raise ValueError("invalid V4 message identity or role")
        source = message.get("source")
        if not isinstance(source, dict) or not isinstance(source.get("kind"), str) or not source["kind"] or source["kind"] == "plugin":
            raise ValueError("invalid V4 message source")
        if any(not isinstance(b, dict) or b.get("type") == "tool-result" for b in message["content"]):
            raise ValueError("legacy tool wrapper is not V4")
        if role == "tool" and (source["kind"] != "tool" or not isinstance(message.get("toolCallId"), str) or message["toolCallId"] != source.get("callId") or ("isError" in message and type(message["isError"]) is not bool)):
            raise ValueError("V4 tool result call identity conflict")
        op = event.get("surfaceOp")
        if op == "append":
            surface.append(seq)
        else:
            if not isinstance(op, dict) or op.get("op") != "replace" or op.get("startSeq") not in surface or op.get("endSeq") not in surface:
                raise ValueError("invalid V4 surface replacement")
            start, end = surface.index(op["startSeq"]), surface.index(op["endSeq"])
            if end < start or any(n not in event.get("sourceEventSeqs", []) for n in surface[start:end+1]):
                raise ValueError("invalid V4 replacement references")
            surface[start:end+1] = [seq]
    if markers and not records[0].get("isSeeded"):
        raise ValueError("invalid V4 inherited cut")
    return markers[-1] if markers else 0
