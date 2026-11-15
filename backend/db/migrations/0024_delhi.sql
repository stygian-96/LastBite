-- Delhi joins the launch cities.
ALTER TABLE areas DROP CONSTRAINT areas_city_check;
ALTER TABLE areas ADD CONSTRAINT areas_city_check CHECK (city IN ('bengaluru','hyderabad','delhi'));
