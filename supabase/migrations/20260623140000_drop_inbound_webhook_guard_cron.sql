-- REVERT 20260623130000: the inbound-webhook-guard cron was built on the wrong
-- (legacy app-bridged) inbound model. Inbound is ElevenLabs-NATIVE: the campaign
-- agent is assigned to the imported EL phone number and Twilio's VoiceUrl points
-- at api.elevenlabs.io/twilio/inbound_call so EL answers inbound directly.
-- Forcing the webhook back at the app BREAKS EL-native inbound, so stop the job.
select cron.unschedule(jobid)
from cron.job
where jobname = 'inbound-webhook-guard';
