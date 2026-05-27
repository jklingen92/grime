web:     python manage.py runserver
worker1: celery -A demo.celery worker -l info --pool=solo -Q slot_1 -n worker1@%h
worker2: celery -A demo.celery worker -l info --pool=solo -Q slot_2 -n worker2@%h
worker3: celery -A demo.celery worker -l info --pool=solo -Q slot_3 -n worker3@%h
