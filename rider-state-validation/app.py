import json

class InvalidLocationException(Exception):
    pass

def handler(event, context):
    print(json.dumps(event))
    
    rider_id = event['rider']['rider_id']
    lat = int(event['rider']['lat'])
    long = int(event['rider']['long'])

    if lat >= 0 and long >= 0:
        return {
            'statusCode': 200,
            'valid': True
        }
    else:
        raise InvalidLocationException(f"Invalid location for {rider_id} with latitue {lat} and longitude {long}")
