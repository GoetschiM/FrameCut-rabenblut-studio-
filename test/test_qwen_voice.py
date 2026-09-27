import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('voice',Path(__file__).parents[1]/'worker/framecut_qwen_tts.py')
voice=importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)
class VoiceTest(unittest.TestCase):
    def test_roles_not_random(self):
        self.assertEqual(voice.speaker_for_voice('Opi, älterer Mann, sonor'),'Uncle_fu')
        self.assertEqual(voice.speaker_for_voice('Junge mit kindlicher Stimme'),'Dylan')
        self.assertEqual(voice.speaker_for_voice('Mutter, weiblich'),'Serena')
    def test_acting_keeps_age_and_language(self):
        prompt=voice.voice_instruction('eight year old boy','panicked')
        for term in ['eight year old boy','panicked','Standard German','Preserve the stated age','No robotic']:
            self.assertIn(term,prompt)
if __name__=='__main__':unittest.main()
