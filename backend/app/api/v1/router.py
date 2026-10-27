from fastapi import APIRouter

from app.api.v1 import access, auth, connections, health, profiles, subscriptions, users


api_router = APIRouter()
api_router.include_router(access.router)
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(connections.router)
api_router.include_router(profiles.router)
api_router.include_router(subscriptions.router)
api_router.include_router(health.router)
