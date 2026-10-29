"""Provider adapter dispatch, credentials and lifecycle without model calls."""
import os
import unittest
from unittest.mock import Mock, patch

from agent.core.model_timing import ModelRequestTiming
from agent.providers.codex import CodexProviderAdapter
from agent.providers.factory import create_provider_adapter
from agent.providers.gemini import GeminiProviderAdapter
from agent.providers.groq import GroqProviderAdapter


class ProviderFactoryTest(unittest.TestCase):
    def test_match_dispatches_to_a_dedicated_adapter(self):
        environment = {'GROQ_API_KEY': 'groq-key', 'GEMINI_API_KEY': 'gemini-key'}
        with patch.dict(os.environ, environment, clear=True), \
                patch('agent.providers.codex.shutil.which', return_value='/test/codex'), \
                patch('agent.providers.codex_client.configured_model', return_value=None):
            cases = {'codex': CodexProviderAdapter, 'groq': GroqProviderAdapter,
                     'gemini': GeminiProviderAdapter}
            for name, adapter_type in cases.items():
                with self.subTest(provider=name):
                    self.assertIsInstance(
                        create_provider_adapter(name, gemini_model='gemini-test'), adapter_type)
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                create_provider_adapter('unknown', gemini_model='gemini-test')

    def test_codex_adapter_defers_client_creation_and_needs_no_api_key(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch('agent.providers.codex.shutil.which', return_value=None), \
                patch('agent.providers.codex_client.configured_model', return_value='configured-model'), \
                patch('agent.providers.codex_client.CodexClient') as client:
            adapter = create_provider_adapter('codex', gemini_model='unused')
            self.assertEqual(adapter.label, 'Codex CLI / configured-model')
            self.assertEqual(len(adapter.startup_messages), 1)
            client.assert_not_called()
            timing = ModelRequestTiming()
            with adapter.create_client(timing):
                pass
            client.assert_called_once_with(timing=timing)
            client.return_value.__exit__.assert_called_once()

    def test_cloud_adapters_own_credentials_and_create_clients_per_turn(self):
        environment = {'GROQ_API_KEY': 'test-groq-key', 'GEMINI_API_KEY': 'test-gemini-key',
                       'GROQ_MODEL': 'configured-groq-model'}
        with patch.dict(os.environ, environment, clear=True), \
                patch('agent.providers.groq_client.GroqClient') as groq, \
                patch('google.genai.Client') as gemini:
            adapters = [create_provider_adapter('groq', gemini_model='gemini-test'),
                        create_provider_adapter('gemini', gemini_model='gemini-test')]
            last_timings = []
            for adapter, constructor in zip(adapters, (groq, gemini)):
                constructor.assert_not_called()
                timings = [ModelRequestTiming(), ModelRequestTiming()]
                for timing in timings:
                    with adapter.create_client(timing):
                        pass
                last_timings.append(timings[-1])
                self.assertEqual(constructor.call_count, 2)
                self.assertEqual(constructor.return_value.__exit__.call_count, 2)
                self.assertNotIn('test-', repr(adapter))
            self.assertEqual(adapters[0].label, 'Groq / configured-groq-model')
            self.assertEqual(groq.call_args.args, ('test-groq-key',))
            self.assertIs(groq.call_args.kwargs['timing'], last_timings[0])
            self.assertEqual(adapters[1].label, 'gemini-test')
            self.assertEqual(gemini.call_args.kwargs['api_key'], 'test-gemini-key')

    def test_missing_credentials_do_not_fall_back_to_another_adapter(self):
        with patch.dict(os.environ, {}, clear=True):
            for name in ('groq', 'gemini'):
                with self.subTest(provider=name), self.assertRaisesRegex(SystemExit, name.upper() + '_API_KEY'):
                    create_provider_adapter(name, gemini_model='test')

    def test_each_adapter_owns_its_stop_behavior(self):
        codex_stop, groq_stop = Mock(), Mock()
        with patch.dict(os.environ, {'GROQ_API_KEY': 'test', 'GEMINI_API_KEY': 'test'}, clear=True), \
                patch('agent.providers.codex_client.STOP', codex_stop), \
                patch('agent.providers.codex_client.configured_model', return_value=None), \
                patch('agent.providers.codex.shutil.which', return_value='/test/codex'), \
                patch('agent.providers.groq_client.REQUEST_PACER.stopped', groq_stop):
            create_provider_adapter('gemini', gemini_model='test').stop()
            codex_stop.set.assert_not_called()
            groq_stop.set.assert_not_called()
            create_provider_adapter('codex', gemini_model='test').stop()
            codex_stop.set.assert_called_once()
            create_provider_adapter('groq', gemini_model='test').stop()
            groq_stop.set.assert_called_once()
