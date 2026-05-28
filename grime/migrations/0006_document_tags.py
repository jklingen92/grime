from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("grime", "0005_workerslot_asyncjob"),
    ]

    operations = [
        migrations.AddField(
            model_name="document",
            name="tags",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
