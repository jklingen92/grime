from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("grime", "0002_alter_word_options_remove_document_column_schema_and_more"),
    ]

    operations = [
        migrations.RenameField(
            model_name="word",
            old_name="text",
            new_name="ocr_text",
        ),
    ]
