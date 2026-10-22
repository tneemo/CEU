"""Language defaults and suggestion cache isolation, without a server or user database."""
import os
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    with tempfile.TemporaryDirectory(prefix="ceu-language-") as folder:
        os.environ["CEU_DATA_DIR"] = folder
        from server import db, suggestions

        db.init()
        assert db.get_settings()["language"] == "en"
        assert suggestions._home_cache_key() == "home_suggestions:en"
        db.set_cache("home_suggestions:en", {"items": ["English suggestion"]})
        assert suggestions.home() == ["English suggestion"]
        db.update_settings({"language": "pt-BR"})
        assert suggestions._home_cache_key() == "home_suggestions:pt-BR"
        assert suggestions.home() == []
        db.set_cache("home_suggestions:pt-BR", {"items": ["Sugestão em português"]})
        assert suggestions.home() == ["Sugestão em português"]
        db.update_settings({"language": "auto"})
        assert suggestions.home() == ["English suggestion"]

        for language, expected in [("en", "inglês"), ("pt-BR", "português")]:
            db.update_settings({"language": language})
            captured = []
            with patch.object(suggestions, "_ask", side_effect=lambda model, prompt: captured.append(prompt)):
                suggestions._home_worker()
            assert f"Escreva em {expected}." in captured[0]
        db.conn().close()
    print("Suggestion language OK: English default, legacy auto, separate caches and localized prompts.")


if __name__ == "__main__":
    main()
