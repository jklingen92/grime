from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("grime", "0006_document_tags"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="Tag",
            new_name="Annotation",
        ),
    ]
