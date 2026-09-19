import io
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ADAPTER = Path(__file__).parents[1] / "worker" / "adapters" / "minimax-h3" / "render_shot.py"


def load_adapter():
    spec = importlib.util.spec_from_file_location("framecut_render_shot", ADAPTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class JsonResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Ref2VAGraphTest(unittest.TestCase):
    def test_identity_refs_are_separate_from_frame_zero_scene_guide(self):
        adapter = load_adapter()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scene = root / "scene.png"
            identity = root / "leo.png"
            prompt = root / "prompt.txt"
            output = root / "out"
            scene.write_bytes(b"scene")
            identity.write_bytes(b"identity")
            prompt.write_text("<Picture 1> is Leo. Leo walks through the scene.", encoding="utf-8")

            def fake_urlopen(request, timeout=120):
                url = request.full_url if hasattr(request, "full_url") else str(request)
                if url.endswith("/upload/image"):
                    return JsonResponse(json.dumps({"name": "uploaded.png"}).encode())
                if url.endswith("/prompt"):
                    return JsonResponse(json.dumps({"prompt_id": "test-prompt"}).encode())
                if "/history/test-prompt" in url:
                    payload = {"test-prompt": {"status": {"status_str": "error"}}}
                    return JsonResponse(json.dumps(payload).encode())
                raise AssertionError(url)

            argv = [
                "render_shot.py", "--base-url", "http://mock", "--image", str(scene),
                "--prompt-file", str(prompt), "--output-dir", str(output), "--name", "shot-test",
                "--reference-image", str(identity), "--reference-image-size", "match",
            ]
            with patch.object(sys, "argv", argv), patch.object(adapter.urllib.request, "urlopen", side_effect=fake_urlopen):
                with self.assertRaises(RuntimeError):
                    adapter.main()

            graph = json.loads((output / "shot-test.workflow.json").read_text(encoding="utf-8"))
            self.assertEqual(graph["cond"]["class_type"], "MiniMaxH3ReferenceToVideo")
            self.assertEqual(graph["cond"]["inputs"]["ref_images.ref_image_0"], ["reference_1", 0])
            self.assertNotIn("first_frame", graph["cond"]["inputs"])
            self.assertEqual(graph["scene_guide"]["class_type"], "MiniMaxH3AddGuide")
            self.assertEqual(graph["scene_guide"]["inputs"]["image"], ["image", 0])
            self.assertEqual(graph["scene_guide"]["inputs"]["frame_idx"], 0)
            self.assertEqual(graph["guide"]["inputs"]["conditioning"], ["scene_guide", 0])


if __name__ == "__main__":
    unittest.main()
